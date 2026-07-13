import { describe, expect, it } from 'bun:test'
import { mcNemarExactTest } from '../../demo/live-ab.ts'

// Builds paired boolean arrays with exactly `b` "control succeeded, treatment failed" pairs,
// `c` "control failed, treatment succeeded" pairs, and the rest concordant (both true), so the
// concordant pairs are present but contribute nothing to the discordant counts under test.
function pairsWithDiscordance(
  b: number,
  c: number,
  concordant = 0,
): { control: boolean[]; treatment: boolean[] } {
  const control: boolean[] = []
  const treatment: boolean[] = []
  for (let i = 0; i < b; i++) {
    control.push(true)
    treatment.push(false)
  }
  for (let i = 0; i < c; i++) {
    control.push(false)
    treatment.push(true)
  }
  for (let i = 0; i < concordant; i++) {
    control.push(true)
    treatment.push(true)
  }
  return { control, treatment }
}

describe('mcNemarExactTest', () => {
  it('returns p=1 when there are no discordant pairs (b=0, c=0)', () => {
    const { control, treatment } = pairsWithDiscordance(0, 0, 4)
    const result = mcNemarExactTest(control, treatment)
    expect(result.b).toBe(0)
    expect(result.c).toBe(0)
    expect(result.p).toBeCloseTo(1, 9)
  })

  it('matches the textbook value for b=0, c=5 (all discordance favors treatment)', () => {
    // p = 2 * C(5,0) * 0.5^5 = 2 * 1/32 = 0.0625
    const { control, treatment } = pairsWithDiscordance(0, 5)
    const result = mcNemarExactTest(control, treatment)
    expect(result.b).toBe(0)
    expect(result.c).toBe(5)
    expect(result.p).toBeCloseTo(0.0625, 9)
  })

  it('matches the textbook value for b=2, c=8', () => {
    // p = 2 * (C(10,0)+C(10,1)+C(10,2)) * 0.5^10 = 2 * (1+10+45)/1024 = 2 * 56/1024 = 0.109375
    const { control, treatment } = pairsWithDiscordance(2, 8)
    const result = mcNemarExactTest(control, treatment)
    expect(result.b).toBe(2)
    expect(result.c).toBe(8)
    expect(result.p).toBeCloseTo(0.109375, 9)
  })

  it('caps p at 1.0 for b=1, c=1 (raw formula value would be 1.5)', () => {
    // raw = 2 * (C(2,0)+C(2,1)) * 0.5^2 = 2 * (1+2)/4 = 1.5, capped at 1.0
    const { control, treatment } = pairsWithDiscordance(1, 1)
    const result = mcNemarExactTest(control, treatment)
    expect(result.b).toBe(1)
    expect(result.c).toBe(1)
    expect(result.p).toBeCloseTo(1, 9)
  })

  it('reports an asymmetric case where only control succeeds (b=3, c=0)', () => {
    // p = 2 * C(3,0) * 0.5^3 = 2 * 1/8 = 0.25
    const control = [true, true, true]
    const treatment = [false, false, false]
    const result = mcNemarExactTest(control, treatment)
    expect(result.b).toBe(3)
    expect(result.c).toBe(0)
    expect(result.p).toBeCloseTo(0.25, 9)
  })

  it('throws on mismatched paired sample lengths, mirroring pairedTTest', () => {
    expect(() => mcNemarExactTest([true, false], [true])).toThrow('Mismatched paired samples')
  })
})
