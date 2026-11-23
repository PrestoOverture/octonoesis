import { expect, test } from 'bun:test'
import { ELX_SUBSET_SEED, type SessionRef, allocate, planSubsets } from './elx-subsets'

const sessions: SessionRef[] = ['a', 'b', 'c', 'd'].flatMap((family, f) =>
  Array.from({ length: 20 + f * 10 }, (_, i) => ({ key: `run/${family}-${i}`, family })),
)
const sizes = [80, 40, 12]

test('allocate hits the total and never exceeds a parent count', () => {
  const counts = allocate({ a: 41, b: 68, c: 57 }, 100)
  expect(Object.values(counts).reduce((x, y) => x + y, 0)).toBe(100)
  expect((counts.a as number) <= 41).toBe(true)
  expect(() => allocate({ a: 1 }, 2)).toThrow()
})

test('the family floor lifts a small family and keeps the total', () => {
  const parent = { small: 41, large: 803 }
  expect(allocate(parent, 800).small).toBe(39)
  const floored = allocate(parent, 800, 40)
  expect((floored.small as number) >= 40).toBe(true)
  expect((floored.small as number) + (floored.large as number)).toBe(800)
  expect(allocate({ a: 3, b: 50 }, 20, 10).a).toBe(3)
  expect(() => allocate({ a: 50, b: 50 }, 10, 10)).toThrow()
})

test('subsets are nested, stratified, and the reserve is disjoint', () => {
  const plan = planSubsets(sessions, sizes, ELX_SUBSET_SEED, 0)
  const [large, medium, small] = sizes.map((n) => new Set(plan.subsets[n]))
  expect([large?.size, medium?.size, small?.size]).toEqual([80, 40, 12])
  for (const key of small as Set<string>) expect(medium?.has(key)).toBe(true)
  for (const key of medium as Set<string>) expect(large?.has(key)).toBe(true)
  expect(plan.reserve.length).toBe(sessions.length - 80)
  expect(plan.reserve.some((key) => large?.has(key))).toBe(false)
  for (const family of ['a', 'b', 'c', 'd']) expect(plan.perFamily[12]?.[family]).toBeGreaterThan(0)
})

test('selection ignores input order and changes with the seed', () => {
  const plan = planSubsets(sessions, sizes, 1, 0)
  const shuffled = planSubsets([...sessions].reverse(), sizes, 1, 0)
  expect(shuffled.subsets).toEqual(plan.subsets)
  expect(planSubsets(sessions, sizes, 2, 0).subsets[12]).not.toEqual(plan.subsets[12])
})

test('duplicate keys and non-descending sizes are refused', () => {
  expect(() => planSubsets([sessions[0] as SessionRef, sessions[0] as SessionRef], [1])).toThrow()
  expect(() => planSubsets(sessions, [10, 20])).toThrow()
})
