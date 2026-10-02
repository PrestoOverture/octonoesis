import { expect, test } from 'bun:test'
import { prepareScreenSequence } from '../../src/ui/screen'

test('scrolls prior rows into scrollback without clearing scrollback', () => {
  const sequence = prepareScreenSequence(30)
  expect(sequence).toBe(`${'\n'.repeat(29)}\x1b[H\x1b[0J`)
  expect(sequence).not.toContain('\x1b[3J')
  expect(sequence).not.toContain('\x1b[2J')
})

test('defaults to 24 rows for unavailable or nonpositive heights', () => {
  for (const rows of [undefined, 0, -1]) {
    expect(prepareScreenSequence(rows)).toBe(`${'\n'.repeat(23)}\x1b[H\x1b[0J`)
  }
})
