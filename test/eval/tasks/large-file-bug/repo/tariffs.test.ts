// @ts-nocheck -- standalone eval fixture; implementation may be absent before solving.
import { expect, test } from 'bun:test'
import { invoice, tariffs } from './src/tariffs'
test('contract', () => {
  expect(tariffs).toHaveLength(2594)
  expect(invoice([0, 1, 2593], 0.25)).toBe(Math.round((7 + 10 + 7786) * 0.75))
  expect(invoice([], 0.2)).toBe(0)
  expect(invoice([9999, 1], 1)).toBe(0)
})
