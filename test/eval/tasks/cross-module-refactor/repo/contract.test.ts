import { expect, test } from 'bun:test'
import * as api from './src/format'
import { view0 } from './src/view0'
import { view1 } from './src/view1'
import { view2 } from './src/view2'
import { view3 } from './src/view3'

test('contract', () => {
  expect('renderUser' in api).toBe(true)
  const render = Reflect.get(api, 'renderUser')
  expect(render(' Ada ')).toBe('Ada')
  expect(render(' Ada ', { uppercase: false })).toBe('Ada')
  expect(render(' Ada ', { uppercase: true })).toBe('ADA')
  expect(view0(' Ada ')).toBe('ADA')
  expect(view1(' Ada ')).toBe('ADA')
  expect(view2(' Ada ')).toBe('ADA')
  expect(view3(' Ada ')).toBe('ADA')

})
