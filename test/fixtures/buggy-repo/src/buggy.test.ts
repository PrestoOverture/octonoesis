import { expect, test } from 'bun:test'
import { handleUser } from './buggy'

test('handles valid user name', () => {
  expect(handleUser({ name: 'alice' })).toBe('Hello, ALICE!')
})

test('handles capitalized name', () => {
  expect(handleUser({ name: 'BOB' })).toBe('Hello, BOB!')
})

test('handles short name', () => {
  expect(handleUser({ name: 'a' })).toBe('Hello, A!')
})

test('handles missing user object', () => {
  expect(handleUser(null)).toBe('Hello, Guest!')
})

test('handles missing name property', () => {
  expect(handleUser({})).toBe('Hello, Guest!')
})
