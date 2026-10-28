import { expect, test } from 'bun:test'
import { clamp } from './src/clamp'
test('contract', () => {
  expect(clamp(-2, 0, 5)).toBe(0)
  expect(clamp(7, 0, 5)).toBe(5)
  expect(clamp(3, 0, 5)).toBe(3)
  expect(clamp(0, 0, 5)).toBe(0)
  expect(clamp(5, 0, 5)).toBe(5)
})
