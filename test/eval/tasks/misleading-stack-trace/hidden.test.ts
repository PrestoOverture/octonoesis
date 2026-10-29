// @ts-nocheck -- standalone eval fixture
import { expect, test } from 'bun:test'
import { checkout } from './src/checkout'
test('defaults and overrides', () => { for (const n of [0.01, 3, 42.5]) { expect(checkout(n)).toBe(`USD ${n.toFixed(2)}`); expect(checkout(n, {currency:'EUR'})).toBe(`EUR ${n.toFixed(2)}`) } expect(() => checkout(1,{currency:'wat'})).toThrow('receipt renderer: unsupported currency') })
