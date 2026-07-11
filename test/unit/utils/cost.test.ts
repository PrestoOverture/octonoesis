import { describe, expect, it } from 'bun:test'
import { estimateCost } from '../../../src/utils/cost'

describe('cost estimation', () => {
  it('prices input and output tokens for every seeded model prefix', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 }

    expect(estimateCost(usage, 'claude-haiku-4-5-20251001')).toEqual({
      costUsd: 4.8,
      priced: true,
    })
    expect(estimateCost(usage, 'claude-sonnet-4-6')).toEqual({
      costUsd: 18,
      priced: true,
    })
    expect(estimateCost(usage, 'gpt-5-nano-2026-01-01')).toEqual({
      costUsd: 0.45,
      priced: true,
    })
    expect(estimateCost(usage, 'gpt-4o-mini')).toEqual({
      costUsd: 0.75,
      priced: true,
    })
  })

  it('derives cache read and write rates from each model input rate', () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    }

    expect(estimateCost(usage, 'claude-haiku-4-5')).toEqual({
      costUsd: 5.88,
      priced: true,
    })
    expect(estimateCost(usage, 'claude-sonnet-4-6-20260101')).toEqual({
      costUsd: 22.05,
      priced: true,
    })
    expect(estimateCost(usage, 'gpt-5-nano')).toEqual({
      costUsd: 0.5175,
      priced: true,
    })
    expect(estimateCost(usage, 'gpt-4o-mini-2024-07-18')).toEqual({
      costUsd: 0.9525,
      priced: true,
    })
  })

  it('distinguishes a known zero-cost usage from an unpriced model', () => {
    const zeroUsage = { input_tokens: 0, output_tokens: 0 }

    expect(estimateCost(zeroUsage, 'CLAUDE-HAIKU-4-5-longest-prefix-suffix')).toEqual({
      costUsd: 0,
      priced: true,
    })
    expect(estimateCost(zeroUsage, 'unknown-model')).toEqual({
      costUsd: 0,
      priced: false,
    })
  })
})
