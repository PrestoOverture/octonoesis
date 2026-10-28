import { expect, test } from 'bun:test'
import { range } from './range'

test('range has the requested length', () => {
  expect(range(3)).toEqual([0, 1, 2])
  expect(range(0)).toEqual([])
  expect(range(1)).toEqual([0])
})
