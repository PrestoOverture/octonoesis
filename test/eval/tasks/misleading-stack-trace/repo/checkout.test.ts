// @ts-nocheck -- standalone eval fixture
import { expect, test } from 'bun:test'
import { checkout } from './src/checkout'
test('checkout', () => expect(checkout(3)).toBe('USD 3.00'))
