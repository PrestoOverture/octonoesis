import { describe, expect, it } from 'bun:test'
import {
  betaInc,
  betaQuantile,
  createPrior,
  credibleInterval,
  intervalWidth,
  posteriorMean,
  update,
} from '../../../../src/memory/calibration/beta.ts'

describe('Beta Distribution Engine', () => {
  it('should create weakly informative prior Beta(2, 2)', () => {
    const prior = createPrior()
    expect(prior.alpha).toBe(2)
    expect(prior.beta).toBe(2)
  })

  it('should update parameters correctly on hit/miss', () => {
    const prior = createPrior()
    const hitState = update(prior, true)
    expect(hitState.alpha).toBe(3)
    expect(hitState.beta).toBe(2)

    const missState = update(prior, false)
    expect(missState.alpha).toBe(2)
    expect(missState.beta).toBe(3)
  })

  it('should compute posterior mean correctly', () => {
    expect(posteriorMean({ alpha: 2, beta: 2 })).toBe(0.5)
    expect(posteriorMean({ alpha: 3, beta: 1 })).toBe(0.75)
    expect(posteriorMean({ alpha: 1, beta: 3 })).toBe(0.25)
  })

  it('should compute exact regularized incomplete beta function (betaInc)', () => {
    // I_0.5(2, 2) = 0.5
    expect(betaInc(0.5, 2, 2)).toBeCloseTo(0.5, 5)

    // I_0.2(2, 2) = 3 * 0.04 * 0.8 + 0.008 = 0.104
    expect(betaInc(0.2, 2, 2)).toBeCloseTo(0.104, 5)

    // I_0(a, b) = 0
    expect(betaInc(0, 2, 2)).toBe(0)
    expect(betaInc(-0.5, 2, 2)).toBe(0)

    // I_1(a, b) = 1
    expect(betaInc(1, 2, 2)).toBe(1)
    expect(betaInc(1.5, 2, 2)).toBe(1)
  })

  it('should compute inverse CDF quantile (betaQuantile)', () => {
    // Quantile of 0.5 for Beta(2, 2) is 0.5
    expect(betaQuantile(0.5, 2, 2)).toBeCloseTo(0.5, 4)

    // Quantile of 0.104 for Beta(2, 2) is 0.2
    expect(betaQuantile(0.104, 2, 2)).toBeCloseTo(0.2, 4)
  })

  it('should compute credible interval bounds', () => {
    // Beta(2, 2) is symmetric, so the 95% credible interval should be symmetric around 0.5
    const [lower, upper] = credibleInterval({ alpha: 2, beta: 2 }, 0.95)
    expect(lower + upper).toBeCloseTo(1.0, 4)
    expect(lower).toBeLessThan(0.5)
    expect(upper).toBeGreaterThan(0.5)

    // Precise 95% CI bounds for Beta(2,2) are [0.0943, 0.9057]
    expect(lower).toBeCloseTo(0.0943, 3)
    expect(upper).toBeCloseTo(0.9057, 3)
  })

  it('should compute credible interval width correctly', () => {
    const width = intervalWidth({ alpha: 2, beta: 2 }, 0.95)
    expect(width).toBeCloseTo(0.9057 - 0.0943, 3)
  })
})
