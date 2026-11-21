/**
 * ELX dataset builder: oracle-PASS teacher transcripts → chat-completions training JSONL.
 *
 * Each sample is one contiguous request history ending in an assistant turn, in exactly the
 * format the OpenAI-compatible provider sends at inference (`toOpenAIRequest`). A session is
 * split into segments wherever the engine rewrote history (compaction, tool-result clearing),
 * so no sample contains a history the model never actually saw.
 *
 *   bun test/dogfood/elx-dataset.ts --out <file.jsonl> <run-dir>...
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Command } from 'commander'
import { toOpenAIRequest } from '../../src/providers/openai'
import type { CanonicalMessage } from '../../src/providers/types'
import {
  type TranscriptExchange,
  parseTranscript,
  replayTranscript,
} from '../../src/state/transcript'
import { elxSplit } from './elx'
import type { Observation } from './model'

export interface DatasetSample {
  messages: ReturnType<typeof toOpenAIRequest>['messages']
  tools: ReturnType<typeof toOpenAIRequest>['tools']
  meta: { session: string; family: string; seed: number; segment: number; run: string }
}

/**
 * Indices of exchanges that end a contiguous segment: the last exchange, and every exchange
 * whose request history is not a prefix of the next request (the engine rewrote history).
 */
export function segmentEnds(exchanges: TranscriptExchange[]): number[] {
  const ends: number[] = []
  exchanges.forEach((exchange, i) => {
    const next = exchanges[i + 1]
    const continues =
      next !== undefined &&
      next.messages.length > exchange.messages.length &&
      exchange.messages.every((m, j) => JSON.stringify(m) === JSON.stringify(next.messages[j]))
    if (!continues) ends.push(i)
  })
  return ends
}

/** Converts the exchange that ends a segment into one training sample. */
export function toSample(exchange: TranscriptExchange, meta: DatasetSample['meta']): DatasetSample {
  const final: CanonicalMessage = { role: 'assistant', content: exchange.response }
  const request = toOpenAIRequest(
    [...exchange.messages, final],
    exchange.tools,
    exchange.system,
    exchange.dynamicSystem,
  )
  return { messages: request.messages, tools: request.tools, meta }
}

const LEAK_PATTERNS: [string, RegExp][] = [
  ['local user path', /\/Users\/[^/\s"]+/],
  ['sk- token', /\bsk-[A-Za-z0-9_-]{8,}\b/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]

/** Returns the names of leak patterns found in serialized dataset text. */
export function leakCheck(text: string, secrets: string[] = []): string[] {
  const found = LEAK_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
  for (const secret of secrets)
    if (secret.length >= 8 && text.includes(secret)) found.push('key literal')
  return found
}

async function passingSessions(runDir: string): Promise<Observation[]> {
  const train = new Set<string>(elxSplit().train)
  const text = await readFile(path.join(runDir, 'events.jsonl'), 'utf8')
  const rows = new Map<string, Observation>()
  const voided = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const event = JSON.parse(line)
    if (event.kind === 'result') rows.set(event.observation.job.id, event.observation)
    if (event.kind === 'void') for (const job of event.jobs) voided.add(job.id)
  }
  // Training data = final hidden oracle PASS. `status` is the RSC first-tested-repair endpoint
  // (FAIL when the first tested edit failed even if the final submission passed); ERROR rows
  // (e.g. a modified measurement fixture) are never trusted.
  return [...rows.values()].filter(
    (row) =>
      row.hidden_status === 'PASS' &&
      row.status !== 'ERROR' &&
      train.has(row.job.task.family) &&
      !voided.has(row.job.id),
  )
}

export async function buildDataset(runDirs: string[]) {
  const samples: DatasetSample[] = []
  const perFamily: Record<string, number> = {}
  const missing: string[] = []
  for (const runDir of runDirs) {
    for (const row of await passingSessions(runDir)) {
      const file = path.join(runDir, 'sessions', row.job.id, 'transcript.jsonl')
      if (!existsSync(file)) {
        missing.push(`${path.basename(runDir)}/${row.job.id}`)
        continue
      }
      const exchanges = replayTranscript(parseTranscript(await readFile(file, 'utf8')))
      if (!exchanges.length) {
        missing.push(`${path.basename(runDir)}/${row.job.id}`)
        continue
      }
      const family = row.job.task.family
      perFamily[family] = (perFamily[family] ?? 0) + 1
      segmentEnds(exchanges).forEach((end, segment) => {
        samples.push(
          toSample(exchanges[end] as TranscriptExchange, {
            session: row.job.id,
            family,
            seed: row.job.task.seed,
            segment,
            run: path.basename(runDir),
          }),
        )
      })
    }
  }
  return { samples, perFamily, missing }
}

if (import.meta.main) {
  const program = new Command()
    .name('bun test/dogfood/elx-dataset.ts')
    .requiredOption('--out <file>', 'Output JSONL')
    .argument('<runDirs...>')
    .parse(process.argv)
  const { out } = program.opts<{ out: string }>()
  const { samples, perFamily, missing } = await buildDataset(program.args)
  const text = `${samples.map((s) => JSON.stringify(s)).join('\n')}\n`
  const secrets = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SPARK_API_KEY']
    .map((k) => process.env[k] ?? '')
    .filter(Boolean)
  const leaks = leakCheck(text, secrets)
  if (leaks.length) {
    console.error(`Refusing to write dataset: found ${leaks.join(', ')}`)
    process.exit(2)
  }
  await writeFile(out, text, { mode: 0o600 })
  const sessions = Object.values(perFamily).reduce((a, b) => a + b, 0)
  console.log(
    JSON.stringify(
      { sessions, samples: samples.length, per_family: perFamily, missing, bytes: text.length },
      null,
      2,
    ),
  )
}
