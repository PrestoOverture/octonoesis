// biome-ignore lint/suspicious/noExplicitAny: Bun.spawn is writable in the test runtime.
declare const Bun: any

import { afterEach, describe, expect, test } from 'bun:test'
import { parseConfig } from '../../../src/config/schema'
import { HookRegistry } from '../../../src/hooks/registry'
import type { CanonicalMessage } from '../../../src/providers/types'
import { CompactError, compact } from '../../../src/query/compact'
import { maybeCompact } from '../../../src/query/engine'

const originalThreshold = process.env.OCTONOESIS_COMPACT_THRESHOLD

afterEach(() => {
  if (originalThreshold === undefined)
    Reflect.deleteProperty(process.env, 'OCTONOESIS_COMPACT_THRESHOLD')
  else process.env.OCTONOESIS_COMPACT_THRESHOLD = originalThreshold
})

function messages(): CanonicalMessage[] {
  return [
    { role: 'user', content: `Pinned ${'x'.repeat(400)}` },
    { role: 'assistant', content: [{ type: 'text', text: `Old ${'y'.repeat(400)}` }] },
    { role: 'user', content: `Older ${'z'.repeat(300)}` },
    { role: 'assistant', content: [{ type: 'text', text: 'recent one' }] },
    { role: 'user', content: 'recent two' },
    { role: 'assistant', content: [{ type: 'text', text: 'recent three' }] },
  ]
}

describe('config compaction guards', () => {
  test('rejects a replacement below minShrinkPercent while zero preserves current behavior', async () => {
    const input = messages()
    const forkFn = async () => ({
      text: 'A summary that is smaller, but not small enough for a strict configured threshold.',
      usage: { input_tokens: 1, output_tokens: 1 },
      turns: 1,
      exitReason: 'completed' as const,
    })

    const accepted = await compact(input, { systemPrompt: 'system', forkFn, minShrinkPercent: 0 })
    expect(accepted.postCompactTokens).toBeLessThan(accepted.preCompactTokens)
    await expect(
      compact(input, { systemPrompt: 'system', forkFn, minShrinkPercent: 99 }),
    ).rejects.toThrow(CompactError)
  })

  test('skips the compaction check during the configured cooldown', async () => {
    process.env.OCTONOESIS_COMPACT_THRESHOLD = '1'
    const originalSpawn = Bun.spawn
    let spawned = false
    Bun.spawn = () => {
      spawned = true
      throw new Error('cooldown should skip before spawning')
    }
    const config = parseConfig({ compaction: { cooldownTurns: 2 } })
    const state = {
      turn: 4,
      messages: messages(),
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'test-model',
      sessionId: 'session',
      repoRoot: process.cwd(),
      injectedRules: [],
      recordedRuleOutcomes: new Set<string>(),
      tasks: new Map(),
      hooks: new HookRegistry(),
      compactConsecutiveFailures: 0,
      compactCircuitOpen: false,
      lastCompactTurn: 3,
      emitSessionState: false,
      input: 'test',
      inputDigest: 'digest',
      rules: [],
      provider: { name: 'anthropic' as const, async *createMessageStream() {} },
      system: 'system',
      dynamicSystem: '',
      tools: [],
    }
    try {
      const generator = maybeCompact(state, { repoRoot: process.cwd(), config })
      const result = await generator.next()
      expect(result.done).toBe(true)
      expect(spawned).toBe(false)
    } finally {
      Bun.spawn = originalSpawn
    }
  })

  test('counts sub-threshold shrink rejections toward the three-strike breaker', async () => {
    process.env.OCTONOESIS_COMPACT_THRESHOLD = '1'
    const originalSpawn = Bun.spawn
    Bun.spawn = () => ({
      pid: 991_033,
      stdin: { write: () => {}, end: async () => {} },
      stdout: new Blob([
        `${JSON.stringify({
          text: 'Small but not ninety-nine-percent smaller.',
          usage: { input_tokens: 1, output_tokens: 1 },
          turns: 1,
          exitReason: 'completed',
        })}\n`,
      ]).stream(),
      stderr: new Blob([]).stream(),
      exited: Promise.resolve(0),
      kill: () => {},
    })
    const config = parseConfig({ compaction: { minShrinkPercent: 99 } })
    const state = {
      turn: 4,
      messages: messages(),
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'test-model',
      sessionId: 'session',
      repoRoot: process.cwd(),
      injectedRules: [],
      recordedRuleOutcomes: new Set<string>(),
      tasks: new Map(),
      hooks: new HookRegistry(),
      compactConsecutiveFailures: 0,
      compactCircuitOpen: false,
      emitSessionState: false,
      input: 'test',
      inputDigest: 'digest',
      rules: [],
      provider: { name: 'anthropic' as const, async *createMessageStream() {} },
      system: 'system',
      dynamicSystem: '',
      tools: [],
    }
    try {
      for (let strike = 1; strike <= 3; strike++) {
        const generator = maybeCompact(state, { repoRoot: process.cwd(), config })
        await generator.next()
        expect(state.compactConsecutiveFailures).toBe(strike)
      }
      expect(state.compactCircuitOpen).toBe(true)
    } finally {
      Bun.spawn = originalSpawn
    }
  })
})
