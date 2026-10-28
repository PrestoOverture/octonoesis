import { expect, test } from 'bun:test'
import { sortScores } from './scores'

test('scores use ascending numeric ordering', () => {
  const scores = [10, 2, -3, 1, 2]
  expect(sortScores(scores)).toEqual([-3, 1, 2, 2, 10])
  expect(scores).toEqual([10, 2, -3, 1, 2])
  expect(sortScores([])).toEqual([])
})
