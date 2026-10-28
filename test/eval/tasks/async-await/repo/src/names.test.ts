import { expect, test } from 'bun:test'
import { loadNames } from './names'

test('waits for asynchronous lookups in input order', async () => {
  const pending = new Map<number, (value: string) => void>()
  const result = loadNames([1, 2], (id) => new Promise((resolve) => pending.set(id, resolve)))
  pending.get(2)?.('two')
  pending.get(1)?.('one')
  expect(await result).toEqual(['one', 'two'])
  expect(await loadNames([], async () => 'unused')).toEqual([])
})
