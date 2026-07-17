import { describe, expect, it } from 'bun:test'
import { experimentRecordSchema } from '../../../src/experiments/schema.ts'

function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    id: 'exp-r2-distiller-variant',
    registered_at: '2026-07-17T00:00:00.000Z',
    hypothesis: 'Distiller variant B produces higher-hit-rate rules than variant A.',
    endpoints: { primary: 'hit_rate_by_prompt_hash', secondary: ['repeat_failure_rate'] },
    test: { method: 'interleaved session-sticky A/B', pass_line: 'p < 0.05 one-sided' },
    arms: [
      { name: 'A', prompt_hashes: ['hash-a1', 'hash-a2'] },
      { name: 'B', prompt_hashes: ['hash-b1'] },
    ],
    status: 'registered',
    ...overrides,
  }
}

describe('experimentRecordSchema', () => {
  it('accepts a valid record and round-trips it losslessly', () => {
    const input = validRecord()
    const result = experimentRecordSchema.safeParse(input)
    expect(result.success).toBe(true)
    expect(result.data).toEqual(input)
  })

  it('accepts a valid record with no arms (registry-only, not yet an A/B experiment)', () => {
    const input = validRecord()
    // biome-ignore lint/performance/noDelete: test fixture mutation, not hot path
    delete (input as { arms?: unknown }).arms
    expect(experimentRecordSchema.safeParse(input).success).toBe(true)
  })

  it('accepts a concluded record carrying result, decision, and concluded_at', () => {
    const input = validRecord({
      status: 'concluded',
      result: 'B beat A on the primary endpoint',
      decision: 'ship variant B',
      concluded_at: '2026-08-01T00:00:00.000Z',
    })
    expect(experimentRecordSchema.safeParse(input).success).toBe(true)
  })

  it('rejects an id that does not match ^exp-[a-z0-9-]+$', () => {
    for (const id of ['not-exp-prefixed', 'exp-Has-Upper', 'exp-has_underscore', 'exp-', 'exp']) {
      const result = experimentRecordSchema.safeParse(validRecord({ id }))
      expect(result.success).toBe(false)
    }
  })

  it('rejects an empty hypothesis', () => {
    const result = experimentRecordSchema.safeParse(validRecord({ hypothesis: '' }))
    expect(result.success).toBe(false)
  })

  it('rejects fewer than 2 arms', () => {
    const zeroArms = experimentRecordSchema.safeParse(validRecord({ arms: [] }))
    expect(zeroArms.success).toBe(false)

    const oneArm = experimentRecordSchema.safeParse(
      validRecord({ arms: [{ name: 'A', prompt_hashes: [] }] }),
    )
    expect(oneArm.success).toBe(false)
  })

  it('rejects duplicate arm names', () => {
    const result = experimentRecordSchema.safeParse(
      validRecord({
        arms: [
          { name: 'A', prompt_hashes: ['h1'] },
          { name: 'A', prompt_hashes: ['h2'] },
        ],
      }),
    )
    expect(result.success).toBe(false)
  })

  it('rejects an arm with an empty name', () => {
    const result = experimentRecordSchema.safeParse(
      validRecord({
        arms: [
          { name: '', prompt_hashes: ['h1'] },
          { name: 'B', prompt_hashes: ['h2'] },
        ],
      }),
    )
    expect(result.success).toBe(false)
  })

  it('rejects a concluded record missing result', () => {
    const result = experimentRecordSchema.safeParse(
      validRecord({
        status: 'concluded',
        decision: 'ship B',
        concluded_at: '2026-08-01T00:00:00.000Z',
      }),
    )
    expect(result.success).toBe(false)
  })

  it('rejects a concluded record missing decision', () => {
    const result = experimentRecordSchema.safeParse(
      validRecord({
        status: 'concluded',
        result: 'B wins',
        concluded_at: '2026-08-01T00:00:00.000Z',
      }),
    )
    expect(result.success).toBe(false)
  })

  it('rejects a concluded record missing concluded_at', () => {
    const result = experimentRecordSchema.safeParse(
      validRecord({ status: 'concluded', result: 'B wins', decision: 'ship B' }),
    )
    expect(result.success).toBe(false)
  })

  it('rejects a concluded record missing all three of result/decision/concluded_at', () => {
    const result = experimentRecordSchema.safeParse(validRecord({ status: 'concluded' }))
    expect(result.success).toBe(false)
  })

  it('rejects an unsupported schema_version', () => {
    const result = experimentRecordSchema.safeParse(validRecord({ schema_version: 2 }))
    expect(result.success).toBe(false)
  })

  it('rejects an unknown status', () => {
    const result = experimentRecordSchema.safeParse(validRecord({ status: 'archived' }))
    expect(result.success).toBe(false)
  })

  it('rejects a non-ISO registered_at', () => {
    const result = experimentRecordSchema.safeParse(validRecord({ registered_at: 'not-a-date' }))
    expect(result.success).toBe(false)
  })

  it('rejects unknown top-level fields (strict)', () => {
    const result = experimentRecordSchema.safeParse(validRecord({ extra_field: 'nope' }))
    expect(result.success).toBe(false)
  })
})
