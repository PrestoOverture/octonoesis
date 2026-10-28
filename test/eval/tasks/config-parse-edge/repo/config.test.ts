import { expect, test } from 'bun:test'
import { parse } from './src/config'
test('contract', () => {
  expect(parse('# comment\na = plain # tail\nb = "a#b" # tail')).toEqual({ a: 'plain', b: 'a#b' })
  expect(parse(String.raw`x = "say \"hi\" # ok" # comment`)).toEqual({ x: 'say "hi" # ok' })
  expect(parse(String.raw`x = "C:\\" # tail`)).toEqual({ x: 'C:\\' })
  expect(parse('x = "a=b"\nx = "last"\ny = ""')).toEqual({ x: 'last', y: '' })
  expect(() => parse('x = "open')).toThrow()
  expect(() => parse('missing')).toThrow()
})
