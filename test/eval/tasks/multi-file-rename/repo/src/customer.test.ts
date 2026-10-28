import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import * as api from './index'

test('Customer is the public domain throughout the modules', () => {
  const { customerLabel } = api as unknown as {
    customerLabel?: (customer: { id: string; displayName: string }) => string
  }
  expect(typeof customerLabel).toBe('function')
  expect(customerLabel?.({ id: 'c1', displayName: 'Ada' })).toBe('Customer c1: Ada')
  expect(existsSync(new URL('./customer.ts', import.meta.url))).toBe(true)
  expect(existsSync(new URL('./user.ts', import.meta.url))).toBe(false)
})
