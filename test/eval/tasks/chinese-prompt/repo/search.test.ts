import { expect, test } from 'bun:test'
import { normalize } from './src/normalize'
import { search } from './src/search'
test('contract', () => {
  expect(normalize(' ＡＢＣ ')).toBe('abc')
  expect(search(['Ａda', 'Bob', ' ada '], ' ＡＤ ')).toEqual(['Ａda', ' ada '])
  expect(search(['甲', '乙'], ' 丙 ')).toEqual([])
})
