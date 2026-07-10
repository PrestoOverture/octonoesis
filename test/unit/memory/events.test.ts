import { describe, expect, test } from 'bun:test'
import {
  EVENT_SCHEMA_VERSIONS,
  type JournalEvent,
  type UnknownJournalEvent,
  compactEventSchema,
  hookEventSchema,
  isKnownJournalEvent,
  journalEventSchema,
  memoryWriteEventSchema,
  parseJournalEvent,
  skillEventSchema,
  taskEventSchema,
} from '../../../src/memory/events'

const assertJournalEvent = (event: JournalEvent): JournalEvent => event
const assertUnknownEvent = (event: UnknownJournalEvent): UnknownJournalEvent => event

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

  test('accepts compact events with or without optional metadata and preserves metadata', () => {
    const withoutMetadata = compactEventSchema.safeParse({
      kind: 'compact',
      pre_tokens: 100,
      post_tokens: 40,
      summary_length: 200,
    })
    const withMetadata = journalEventSchema.safeParse({
      kind: 'compact',
      pre_tokens: 100,
      post_tokens: 40,
      summary_length: 200,
      ts: '2026-07-10T00:00:00.000Z',
      session_id: 'session-v2',
      schema_version: 2,
    })

    expect(withoutMetadata.success).toBe(true)
    expect(
      journalEventSchema.safeParse({
        kind: 'compact',
        pre_tokens: 100,
        post_tokens: 40,
        summary_length: 200,
      }).success,
    ).toBe(true)
    expect(withMetadata.success).toBe(true)
    if (withMetadata.success) {
      expect(withMetadata.data.ts).toBe('2026-07-10T00:00:00.000Z')
      expect(withMetadata.data.session_id).toBe('session-v2')
      expect(withMetadata.data.schema_version).toBe(2)
    }
  })

  test('accepts the other four v2 event shapes through their schemas and the union', () => {
    const cases = [
      {
        schema: memoryWriteEventSchema,
        event: {
          kind: 'memory_write',
          name: 'typescript-style',
          type: 'project',
          action: 'create',
        },
      },
      {
        schema: skillEventSchema,
        event: { kind: 'skill', skill: 'review', context: 'fork', duration_ms: 12 },
      },
      {
        schema: taskEventSchema,
        event: { kind: 'task', task_id: 'task-1', type: 'agent', status: 'running' },
      },
      {
        schema: hookEventSchema,
        event: {
          kind: 'hook',
          hook_event: 'post_tool',
          hook_type: 'function',
          duration_ms: 4,
          outcome: 'success',
        },
      },
    ]

    for (const { schema, event } of cases) {
      expect(schema.safeParse(event).success).toBe(true)
      expect(journalEventSchema.safeParse(event).success).toBe(true)
      expect(
        journalEventSchema.safeParse({
          ...event,
          ts: '2026-07-10T00:00:00.000Z',
          session_id: 'session-v2',
          schema_version: 2,
        }).success,
      ).toBe(true)
    }
  })

  test('preserves optional metadata on every v0.2 kind', () => {
    const oldEvents = [
      {
        kind: 'tool',
        tool: 'Read',
        input_digest: 'digest',
        outcome: 'success',
        error_class: null,
        duration_ms: 1,
      },
      { kind: 'permission', decision: 'allow_once', key: 'Read:digest' },
      { kind: 'turn', turn: 1 },
      {
        kind: 'session',
        exit_reason: 'completed',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      {
        kind: 'verify',
        verdict: 'PASS',
        fingerprints: [],
        command: 'bun test',
        exit_code: 0,
        stale: false,
      },
      { kind: 'user', digest: 'digest', cancel: false },
    ]

    for (const event of oldEvents) {
      const parsed = journalEventSchema.safeParse({
        ...event,
        ts: '2026-07-10T00:00:00.000Z',
        session_id: 'session-v1',
        schema_version: 1,
      })
      expect(parsed.success).toBe(true)
      if (parsed.success) {
        expect(parsed.data.ts).toBe('2026-07-10T00:00:00.000Z')
        expect(parsed.data.session_id).toBe('session-v1')
        expect(parsed.data.schema_version).toBe(1)
      }
    }
  })

  test('accepts all six session exit reasons', () => {
    for (const exit_reason of [
      'completed',
      'max_turns',
      'fatal_error',
      'user_cancel',
      'budget_exceeded',
      'prompt_too_long',
    ]) {
      expect(
        journalEventSchema.safeParse({
          kind: 'session',
          exit_reason,
          usage: { input_tokens: 1, output_tokens: 1 },
        }).success,
      ).toBe(true)
    }
  })

  test('maps all known kinds to their schema versions', () => {
    expect(EVENT_SCHEMA_VERSIONS).toEqual({
      tool: 1,
      permission: 1,
      turn: 1,
      session: 1,
      verify: 1,
      user: 1,
      compact: 2,
      memory_write: 2,
      skill: 2,
      task: 2,
      hook: 2,
    })
  })

  test('triages known, unknown, and malformed raw values', () => {
    const known = parseJournalEvent({
      kind: 'turn',
      turn: 2,
      ts: '2026-07-10T00:00:00.000Z',
      session_id: 'session-v1',
      schema_version: 1,
    })
    const futureRaw = {
      kind: 'future_kind',
      ts: '2026-07-10T00:00:01.000Z',
      session_id: 'session-future',
      schema_version: 9,
      extra: { preserved: true },
    }
    const unknown = parseJournalEvent(futureRaw)

    expect(known).not.toBe(null)
    if (known && isKnownJournalEvent(known)) {
      const typed = assertJournalEvent(known)
      expect(typed.ts).toBe('2026-07-10T00:00:00.000Z')
      expect(typed.session_id).toBe('session-v1')
      expect(typed.schema_version).toBe(1)
    } else {
      throw new Error('turn event should parse as known')
    }

    expect(unknown).not.toBe(null)
    if (unknown) {
      const typed = assertUnknownEvent(unknown)
      expect(isKnownJournalEvent(typed)).toBe(false)
      expect(typed).toEqual(futureRaw)
    }

    expect(parseJournalEvent({ no_kind: true })).toBe(null)
    expect(parseJournalEvent('not-an-object')).toBe(null)
    expect(journalEventSchema.safeParse(futureRaw).success).toBe(false)
  })
})
