import { describe, expect, it } from 'bun:test'
import { bucketKey } from '../../../../src/memory/calibration/bucket.ts'
import type { Fingerprint } from '../../../../src/memory/fingerprint/extract.ts'

describe('Task Bucketing', () => {
  it('should use the coarse level of the first fingerprint when present', () => {
    const mockFingerprints: Fingerprint[] = [
      {
        tool: 'bun-test',
        error_class: 'TypeError',
        file: 'src/buggy.ts',
        expression: "evaluating 'user.name'",
        coarse: 'bun-test|TypeError',
        medium: 'bun-test|TypeError|src/buggy.ts',
        fine: "bun-test|TypeError|src/buggy.ts|evaluating 'user.name'",
      },
      {
        tool: 'bun-test',
        error_class: 'ReferenceError',
        file: 'src/other.ts',
        expression: 'not found',
        coarse: 'bun-test|ReferenceError',
        medium: 'bun-test|ReferenceError|src/other.ts',
        fine: 'bun-test|ReferenceError|src/other.ts|not found',
      },
    ]

    const key = bucketKey(mockFingerprints)
    expect(key).toBe('bun-test|TypeError')
  })

  it('should fall back to fallbackTool name when fingerprints are empty', () => {
    const key = bucketKey([], 'Edit')
    expect(key).toBe('Edit')
  })

  it("should return 'unknown-tool' when fingerprints and fallbackTool are missing", () => {
    const key = bucketKey([])
    expect(key).toBe('unknown-tool')
  })
})
