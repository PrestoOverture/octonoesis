import { describe, expect, it } from 'bun:test'
import { DEFAULT_ANTHROPIC_MODEL } from '../../../src/providers/anthropic'

describe('anthropic provider', () => {
  it('exports a pinned model constant', () => {
    expect(DEFAULT_ANTHROPIC_MODEL).toBe('claude-haiku-4-5-20251001')
    expect(DEFAULT_ANTHROPIC_MODEL).not.toContain('latest')
  })
})
