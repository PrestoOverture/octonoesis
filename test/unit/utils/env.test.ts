import { describe, expect, it } from 'bun:test'
import { getAnthropicKey } from '../../../src/utils/env'

describe('getAnthropicKey', () => {
  it('returns the key when set', () => {
    const original = process.env.ANTHROPIC_API_KEY
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
      expect(getAnthropicKey()).toBe('sk-ant-test-key')
    } finally {
      if (original === undefined) {
        process.env.ANTHROPIC_API_KEY = undefined
      } else {
        process.env.ANTHROPIC_API_KEY = original
      }
    }
  })

  it('throws a friendly error when missing', () => {
    const original = process.env.ANTHROPIC_API_KEY
    try {
      process.env.ANTHROPIC_API_KEY = undefined
      expect(() => getAnthropicKey()).toThrow('ANTHROPIC_API_KEY is not set')
    } finally {
      if (original !== undefined) {
        process.env.ANTHROPIC_API_KEY = original
      }
    }
  })
})
