import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appendEpisodes } from '../../../../src/memory/episodes/store.ts'
import type { Episode } from '../../../../src/memory/episodes/types.ts'
import {
  AUTO_DISTILL_MAX_CALLS_PER_SESSION,
  runSessionEndAutoDistill,
} from '../../../../src/memory/rules/autoDistill.ts'
import { rebuildRules } from '../../../../src/memory/rules/rebuild.ts'
import { loadAllRules, saveRule } from '../../../../src/memory/rules/store.ts'
import type { RuleFile } from '../../../../src/memory/rules/types.ts'
import { setProvider } from '../../../../src/providers/index.ts'
import type { CanonicalMessage, LLMProvider } from '../../../../src/providers/types.ts'

const originalEnv = {
  memoryDir: process.env.OCTONOESIS_MEMORY_DIR,
  repoRoot: process.env.OCTONOESIS_REPO_ROOT,
  disableMemory: process.env.OCTONOESIS_DISABLE_MEMORY,
  disableAutoDistill: process.env.OCTONOESIS_DISABLE_AUTO_DISTILL,
}

let tempDir = ''

function episode(index: number, overrides: Partial<Episode> = {}): Episode {
  const file = `src/bug-${index}.ts`
  return {
    id: `ep_${String(index).padStart(4, '0')}`,
    timestamp: new Date(Date.now() + index).toISOString(),
    session_id: 'session-auto-distill',
    task_digest: `fix bug ${index}`,
    failure: {
      tool: 'Bash',
      cmd: 'bun test',
      error_class: 'TypeError',
      signature: `bash|TypeError|${file}|case-${index}`,
    },
    fix_candidates: [
      {
        tool: 'Edit',
        path: file,
        summary: `fixed bug ${index}`,
        role: 'direct',
      },
    ],
    attribution: {
      status: 'single_direct',
      primary: file,
      confidence: 0.9,
    },
    verification: { cmd: 'bun test', exit_code: 0 },
    outcome: 'resolved',
    journal_line_range: { start: index * 3 - 2, end: index * 3 },
    value_score: 1,
    is_excluded: false,
    exclusion_reason: null,
    ...overrides,
  }
}

function promptText(messages: CanonicalMessage[]): string {
  const content = messages[0]?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.find((block) => block.type === 'text')?.text ?? ''
}

function distillProvider(onCall?: (call: number) => void): LLMProvider {
  let calls = 0
  return {
    name: 'anthropic',
    createMessageStream: async function* (messages) {
      calls++
      onCall?.(calls)
      const prompt = promptText(messages)
      const signature = prompt.match(/^- Error signature: (.+)$/m)?.[1] ?? 'bash|Error'
      const anchor = prompt.match(/^- File: (.+?) \(Role:/m)?.[1] ?? ''
      const slug = `auto-${signature.split('|').at(-1)}`
      yield {
        type: 'text_delta',
        text: JSON.stringify({
          slug,
          triggers: {
            tools: ['Bash'],
            command_prefix: ['bun test'],
            error_signatures: [signature],
          },
          anchor_file: anchor,
          advice: `Resolve ${signature}.`,
        }),
      }
    },
  }
}

async function createAnchorFiles(count: number): Promise<void> {
  await fs.mkdir(path.join(tempDir, 'src'), { recursive: true })
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      fs.writeFile(path.join(tempDir, `src/bug-${index + 1}.ts`), 'export {}\n'),
    ),
  )
}

function coveringRule(sourceEpisode: Episode): RuleFile {
  return {
    id: 'rule-existing-active',
    triggers: {
      tools: ['Bash'],
      command_prefix: ['bun test'],
      error_signatures: [sourceEpisode.failure.signature],
    },
    scope: 'repo',
    alpha: 7,
    beta: 2,
    confidence: 0.7778,
    evidence: ['ep_existing'],
    hits: 0,
    misses: 0,
    challenged_by: [],
    anchor: { file: sourceEpisode.fix_candidates[0]?.path ?? '' },
    status: 'active',
    user_confirmed: false,
    extractor_version: '0.2.0',
    model_id: 'mock-model',
    prompt_hash: '12345678',
    created_at: sourceEpisode.timestamp,
    last_matched_at: null,
    last_rebuilt_at: null,
    advice: 'Existing advice.',
  }
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-auto-distill-'))
  process.env.OCTONOESIS_MEMORY_DIR = tempDir
  process.env.OCTONOESIS_REPO_ROOT = tempDir
  Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_MEMORY')
  Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_AUTO_DISTILL')
  setProvider(null)
})

afterEach(async () => {
  setProvider(null)
  await fs.rm(tempDir, { recursive: true, force: true })
  for (const [key, value] of Object.entries({
    OCTONOESIS_MEMORY_DIR: originalEnv.memoryDir,
    OCTONOESIS_REPO_ROOT: originalEnv.repoRoot,
    OCTONOESIS_DISABLE_MEMORY: originalEnv.disableMemory,
    OCTONOESIS_DISABLE_AUTO_DISTILL: originalEnv.disableAutoDistill,
  })) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

describe('session-end auto-distillation', () => {
  it('makes zero distillation calls when memory or auto-distillation is disabled', async () => {
    await createAnchorFiles(1)
    await appendEpisodes([episode(1)])
    let calls = 0
    setProvider(distillProvider(() => calls++))

    for (const flag of ['OCTONOESIS_DISABLE_MEMORY', 'OCTONOESIS_DISABLE_AUTO_DISTILL'] as const) {
      process.env[flag] = 'true'
      await runSessionEndAutoDistill('session-auto-distill', tempDir)
      Reflect.deleteProperty(process.env, flag)
    }

    expect(calls).toBe(0)
    expect(await loadAllRules()).toEqual([])
  })

  it('caps eligible episode distillation at the named default of three LLM calls', async () => {
    await createAnchorFiles(5)
    await appendEpisodes([episode(1), episode(2), episode(3), episode(4), episode(5)])
    let calls = 0
    setProvider(distillProvider(() => calls++))

    await runSessionEndAutoDistill('session-auto-distill', tempDir)

    expect(AUTO_DISTILL_MAX_CALLS_PER_SESSION).toBe(3)
    expect(calls).toBe(3)
    expect((await loadAllRules()).length).toBe(3)
  })

  it('skips excluded, abandoned, unattributable, zero-value, and active-covered episodes', async () => {
    await createAnchorFiles(5)
    const activeCovered = episode(5)
    await appendEpisodes([
      episode(1, { is_excluded: true, exclusion_reason: 'transient' }),
      episode(2, { outcome: 'abandoned' }),
      episode(3, {
        attribution: { status: 'unattributable', confidence: 0.1 },
      }),
      episode(4, { value_score: 0 }),
      activeCovered,
    ])
    await saveRule(coveringRule(activeCovered))
    let calls = 0
    setProvider(distillProvider(() => calls++))

    await runSessionEndAutoDistill('session-auto-distill', tempDir)

    expect(calls).toBe(0)
    expect((await loadAllRules()).map((rule) => rule.id)).toEqual(['rule-existing-active'])
  })

  it('produces the same semantic rule as rebuild-rules for the same episode', async () => {
    await createAnchorFiles(1)
    await appendEpisodes([episode(1)])
    setProvider(distillProvider())

    await runSessionEndAutoDistill('session-auto-distill', tempDir, {
      model: 'mock-model',
      extractorVersion: '0.2.0',
    })
    const [autoRule] = await loadAllRules()

    const rebuiltRulesDir = path.join(tempDir, 'rebuilt-rules')
    await rebuildRules(path.join(tempDir, 'episodes.jsonl'), rebuiltRulesDir, {
      model: 'mock-model',
      extractorVersion: '0.2.0',
      forceDistill: true,
    })
    const [rebuiltRule] = await loadAllRules(rebuiltRulesDir)

    expect(autoRule).toBeDefined()
    expect(rebuiltRule).toBeDefined()
    const { last_rebuilt_at: autoRebuiltAt, ...autoSemanticRule } = autoRule as RuleFile
    const { last_rebuilt_at: rebuiltAt, ...rebuiltSemanticRule } = rebuiltRule as RuleFile
    expect(autoSemanticRule).toEqual(rebuiltSemanticRule)
    expect(autoRebuiltAt).toBe(null)
    expect(rebuiltAt === null).toBe(false)
  })

  it('continues after one episode fails to distill', async () => {
    await createAnchorFiles(2)
    await appendEpisodes([episode(1), episode(2)])
    let calls = 0
    const provider = distillProvider()
    const baseStream = provider.createMessageStream.bind(provider)
    provider.createMessageStream = async function* (...args) {
      calls++
      if (calls === 1) {
        throw new Error('mock distillation failure')
      }
      yield* baseStream(...args)
    }
    setProvider(provider)

    await expect(runSessionEndAutoDistill('session-auto-distill', tempDir)).resolves.toBeUndefined()

    expect(calls).toBe(2)
    expect((await loadAllRules()).length).toBe(1)
  })
})
