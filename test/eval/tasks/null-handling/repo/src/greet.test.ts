import { expect, test } from 'bun:test'
import { greet } from './greet'

test('greetings handle absent users and names', () => {
  expect(greet({ name: 'Ada' })).toBe('Hello, ADA!')
  expect(greet(null)).toBe('Hello, Guest!')
  expect(greet()).toBe('Hello, Guest!')
  expect(greet({})).toBe('Hello, Guest!')
})
