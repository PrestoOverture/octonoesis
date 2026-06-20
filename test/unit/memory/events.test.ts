import { describe, expect, test } from 'bun:test'
import { journalEventSchema } from '../../../src/memory/events'

describe('Journal Event Schema', () => {
  test('validates correct tool event', () => {
    const event = {
      kind: 'tool' as const,
      tool: 'Read',
      input_digest: 'abc123hash',
      outcome: 'success' as const,
      error_class: null,
      duration_ms: 150,
    }
    const parse = journalEventSchema.safeParse(event)
    expect(parse.success).toBe(true)
  })

  test('validates correct permission event', () => {
    const event = {
      kind: 'permission' as const,
      decision: 'allow_once' as const,
      key: 'Read:abc',
    }
    const parse = journalEventSchema.safeParse(event)
    expect(parse.success).toBe(true)
  })

  test('validates correct turn event', () => {
    const event = {
      kind: 'turn' as const,
      turn: 1,
    }
    const parse = journalEventSchema.safeParse(event)
    expect(parse.success).toBe(true)
  })

  test('validates correct session event', () => {
    const event = {
      kind: 'session' as const,
      exit_reason: 'completed' as const,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
      },
    }
    const parse = journalEventSchema.safeParse(event)
    expect(parse.success).toBe(true)
  })

  test('validates correct verify event', () => {
    const event = {
      kind: 'verify' as const,
      verdict: 'PASS' as const,
      fingerprints: [],
      command: 'bun test',
      exit_code: 0,
      stale: false,
    }
    const parse = journalEventSchema.safeParse(event)
    expect(parse.success).toBe(true)
  })

  test('validates correct user event', () => {
    const event = {
      kind: 'user' as const,
      digest: 'user_prompt_hash',
      cancel: false,
    }
    const parse = journalEventSchema.safeParse(event)
    expect(parse.success).toBe(true)
  })

  test('rejects malformed event', () => {
    const event = {
      kind: 'tool' as const,
      // missing tool name
      input_digest: 'abc',
      outcome: 'invalid_outcome', // bad enum value
      duration_ms: 'one hundred', // bad type
    }
    const parse = journalEventSchema.safeParse(event)
    expect(parse.success).toBe(false)
  })
})
