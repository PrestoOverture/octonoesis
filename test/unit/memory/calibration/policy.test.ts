import { describe, expect, it } from 'bun:test'
import type { BetaParams } from '../../../../src/memory/calibration/beta.ts'
import { assessBucket } from '../../../../src/memory/calibration/policy.ts'

describe('Fails-Safe Calibration Policy', () => {
  it("should return 'uncertain' when data is sparse (e.g. prior Beta(2, 2))", () => {
    const params: BetaParams = { alpha: 2, beta: 2 } // total = 4
    expect(assessBucket(params)).toBe('uncertain')
  })

  it("should return 'uncertain' even with partial observations if CI width is still wide", () => {
    const params: BetaParams = { alpha: 5, beta: 5 } // total = 10
    expect(assessBucket(params)).toBe('uncertain')
  })

  it("should return 'confident' when CI width is narrow (< 0.5) and posterior mean >= 0.6", () => {
    const params: BetaParams = { alpha: 30, beta: 5 } // total = 35, mean = 0.857
    expect(assessBucket(params)).toBe('confident')
  })

  it("should return 'review-recommended' when CI width is narrow (< 0.5) but posterior mean < 0.6", () => {
    const params: BetaParams = { alpha: 20, beta: 30 } // total = 50, mean = 0.4
    expect(assessBucket(params)).toBe('review-recommended')
  })

  it('should verify roadmap examples correctly', () => {
    expect(assessBucket({ alpha: 2, beta: 2 })).toBe('uncertain') // width 0.81
    expect(assessBucket({ alpha: 12, beta: 3 })).toBe('confident') // mean 0.8, width 0.38
    expect(assessBucket({ alpha: 3, beta: 8 })).toBe('review-recommended') // mean 0.27, width 0.49
  })
})
