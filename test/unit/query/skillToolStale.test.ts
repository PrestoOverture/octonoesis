import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setProvider } from '../../../src/providers'
import type {
  CanonicalMessage,
  CanonicalTool,
  LLMProvider,
  StreamEvent as ProviderStreamEvent,
} from '../../../src/providers/types'
import { query } from '../../../src/query/engine'
import { clearSkillCacheForTesting } from '../../../src/skills/loader'
import { getTool } from '../../../src/tools/registry'

const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
let tempDir = ''
let repoRoot = ''
let memoryDir = ''
let skillsDir = ''

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-skill-stale-'))
  repoRoot = path.join(tempDir, 'repo')
  memoryDir = path.join(tempDir, 'state')
  skillsDir = path.join(repoRoot, '.octonoesis', 'skills')
  await fs.mkdir(skillsDir, { recursive: true })
  process.env.OCTONOESIS_MEMORY_DIR = memoryDir
})

afterEach(async () => {
  setProvider(null)
  clearSkillCacheForTesting()
  await fs.rm(tempDir, { recursive: true, force: true })
  if (originalMemoryDir === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  } else {
    process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
  }
})

/** Completes with no tool use, regardless of what was sent. */
class CapturingProvider implements LLMProvider {
  readonly name = 'anthropic' as const

  async *createMessageStream(
    _messages: CanonicalMessage[],
    _tools: CanonicalTool[],
  ): AsyncIterable<ProviderStreamEvent> {
    yield { type: 'text_delta', text: 'Done.' }
    yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
  }
}

async function runToCompletion(ctx: Parameters<typeof query>[1], message: string) {
  const generator = query(message, ctx)
  let step = await generator.next()
  while (!step.done) {
    step = await generator.next()
  }
  return step.value
}

describe('SkillTool registration does not go stale across queries on one ctx', () => {
  it('unregisters Skill once a previously-installed skill disappears from disk', async () => {
    await fs.writeFile(
      path.join(skillsDir, 'test-skill.md'),
      '---\ndescription: temp skill for stale-registration coverage\n---\nDo something useful.',
    )

    setProvider(new CapturingProvider())
    const ctx = { repoRoot, sessionId: 'skill-stale-session' }

    const first = await runToCompletion(ctx, 'Say hello')
    expect(first.exit_reason).toBe('completed')
    expect(getTool('Skill')).toBeDefined()
    expect(getTool('Skill')?.name).toBe('Skill')

    // Remove the skill from disk and force loadSkills to rescan (it caches per repoRoot for the
    // life of the process — the real TUI process would only ever see a fresh repoRoot once, but
    // the cache must not be the reason this test passes).
    await fs.rm(path.join(skillsDir, 'test-skill.md'))
    clearSkillCacheForTesting()

    const second = await runToCompletion(ctx, 'Say hello again')
    expect(second.exit_reason).toBe('completed')
    expect(getTool('Skill')).toBeUndefined()
  })

  it('leaves Skill unregistered across two skill-less queries on one ctx', async () => {
    setProvider(new CapturingProvider())
    const ctx = { repoRoot, sessionId: 'skill-stale-session-none' }

    expect(getTool('Skill')).toBeUndefined()
    const first = await runToCompletion(ctx, 'Say hello')
    expect(first.exit_reason).toBe('completed')
    expect(getTool('Skill')).toBeUndefined()

    const second = await runToCompletion(ctx, 'Say hello again')
    expect(second.exit_reason).toBe('completed')
    expect(getTool('Skill')).toBeUndefined()
  })
})
