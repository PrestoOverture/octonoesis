import { expect, test } from 'bun:test'
import * as api from './index'

test('public API exports double', () => {
  const { double } = api as { double?: (value: number) => number }
  expect(typeof double).toBe('function')
  expect(double?.(3)).toBe(6)
  expect(double?.(-2)).toBe(-4)
})
