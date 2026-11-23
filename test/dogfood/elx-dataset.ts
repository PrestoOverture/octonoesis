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
import os from 'node:os'
import path from 'node:path'
import { Command } from 'commander'
import { toOpenAIRequest } from '../../src/providers/openai'
import type { CanonicalMessage } from '../../src/providers/types'
import {
  type TranscriptExchange,
  parseTranscript,
  redactDeep,
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
  ['harness path', /octonoesis-dogfood/],
]

function usernamePattern(username: string): RegExp {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'g')
}

/** Returns the names of leak patterns found in serialized dataset text. */
export function leakCheck(text: string, secrets: string[] = [], username?: string): string[] {
  const found = LEAK_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
  for (const secret of secrets)
    if (secret.length >= 8 && text.includes(secret)) found.push('key literal')
  if (username && username !== 'user' && usernamePattern(username).test(text))
    found.push('local username')
  return found
}

/**
 * Removes what transcript redaction cannot know: the account name in `ls -l` style tool output
 * and the harness's run directory in background-task log paths.
 */
export function scrubSample(sample: DatasetSample, username: string): DatasetSample {
  const owner = usernamePattern(username)
  const scrub = (text: string) =>
    text
      .replace(
        /\/home\/user\/projects\/octonoesis-dogfood\/[^/\s"\\]+\/ledgers\/[^/\s"\\]+\//g,
        '/home/user/.octonoesis/',
      )
      .replace(owner, 'user')
  return {
    ...sample,
    messages: redactDeep(sample.messages, scrub),
    tools: redactDeep(sample.tools, scrub),
  }
}

async function passingSessions(runDir: string): Promise<Observation[]> {
  const train = new Set<string>(elxSplit().train)
  const text = await readFile(path.join(runDir, 'events.jsonl'), 'utf8')
  const rows = new Map<string, Observation>()
  // Events are chronological: a void cancels earlier results, and a rerun after it counts.
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const event = JSON.parse(line)
    if (event.kind === 'result') rows.set(event.observation.job.id, event.observation)
    if (event.kind === 'void') for (const job of event.jobs) rows.delete(job.id)
  }
  // Training data = final hidden oracle PASS. `status` is the RSC first-tested-repair endpoint
  // (FAIL when the first tested edit failed even if the final submission passed); ERROR rows
  // (e.g. a modified measurement fixture) are never trusted.
  return [...rows.values()].filter(
    (row) =>
      row.hidden_status === 'PASS' && row.status !== 'ERROR' && train.has(row.job.task.family),
  )
}

export async function buildDataset(
  runDirs: string[],
  username = os.userInfo().username,
  exclude: ReadonlySet<string> = new Set(),
) {
  const samples: DatasetSample[] = []
  const perFamily: Record<string, number> = {}
  const missing: string[] = []
  const excluded: string[] = []
  for (const runDir of runDirs) {
    for (const row of await passingSessions(runDir)) {
      // `<run>/<job>`: job ids repeat across runs. Used for sessions that inspected the harness.
      const key = `${path.basename(runDir)}/${row.job.id}`
      if (exclude.has(key)) {
        excluded.push(key)
        continue
      }
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
          scrubSample(
            toSample(exchanges[end] as TranscriptExchange, {
              session: row.job.id,
              family,
              seed: row.job.task.seed,
              segment,
              run: path.basename(runDir),
            }),
            username,
          ),
        )
      })
    }
  }
  return { samples, perFamily, missing, excluded }
}

if (import.meta.main) {
  const program = new Command()
    .name('bun test/dogfood/elx-dataset.ts')
    .requiredOption('--out <file>', 'Output JSONL')
    .option('--exclude <keys>', 'Comma-separated <run>/<job> sessions to leave out')
    .argument('<runDirs...>')
    .parse(process.argv)
  const { out, exclude } = program.opts<{ out: string; exclude?: string }>()
  const excludeKeys = new Set((exclude ?? '').split(',').filter(Boolean))
  const { samples, perFamily, missing, excluded } = await buildDataset(
    program.args,
    os.userInfo().username,
    excludeKeys,
  )
  const unmatched = [...excludeKeys].filter((key) => !excluded.includes(key))
  if (unmatched.length) {
    console.error(
      `Refusing to write dataset: --exclude matched nothing for ${unmatched.join(', ')}`,
    )
    process.exit(2)
  }
  const text = `${samples.map((s) => JSON.stringify(s)).join('\n')}\n`
  const secrets = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SPARK_API_KEY']
    .map((k) => process.env[k] ?? '')
    .filter(Boolean)
  const leaks = leakCheck(text, secrets, os.userInfo().username)
  if (leaks.length) {
    console.error(`Refusing to write dataset: found ${leaks.join(', ')}`)
    process.exit(2)
  }
  await writeFile(out, text, { mode: 0o600 })
  const sessions = Object.values(perFamily).reduce((a, b) => a + b, 0)
  console.log(
    JSON.stringify(
      {
        sessions,
        samples: samples.length,
        per_family: perFamily,
        missing,
        excluded,
        bytes: text.length,
      },
      null,
      2,
    ),
  )
}
