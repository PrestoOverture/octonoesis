import { expect, test } from 'bun:test'
import { checkout } from './src/checkout'
test('contract', () => {
  expect(checkout({ unit_cents: 125, quantity: 3 })).toBe('3.75')
  expect(checkout({ unit_cents: 0, quantity: 0 })).toBe('0.00')
})
