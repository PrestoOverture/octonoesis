import { describe, expect, it } from 'bun:test'

describe('dbg', () => {
  it('does not write when DEBUG is off', () => {
    const original = process.env.DEBUG
    try {
      process.env.DEBUG = undefined
      const errors: string[] = []
      const originalError = console.error
      console.error = (...args: unknown[]) => {
        errors.push(args.join(' '))
      }
      try {
        // Re-import to pick up fresh isDebug
        // Since isDebug is evaluated at module load, we test the exported function behavior
        const { dbg } = require('../../../src/utils/debug')
        dbg('test', 'should not appear')
        expect(errors.length).toBe(0)
      } finally {
        console.error = originalError
      }
    } finally {
      if (original !== undefined) {
        process.env.DEBUG = original
      }
    }
  })
})
