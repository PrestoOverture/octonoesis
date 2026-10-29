// @ts-nocheck -- standalone eval fixture
import { expect, test } from 'bun:test'
import { coalesce } from './src/ranges'
test('overlap',()=>expect(coalesce([[4,8],[1,5]])).toEqual([[1,8]]))
