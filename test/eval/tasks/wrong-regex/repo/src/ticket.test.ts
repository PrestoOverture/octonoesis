import { expect, test } from 'bun:test'
import { isTicket } from './ticket'

test('ticket identifiers match the whole input', () => {
  for (const value of ['BUG-1', 'BUG-204']) expect(isTicket(value)).toBe(true)
  for (const value of ['', 'BUG-', 'xBUG-1', 'BUG-2x', 'bug-3']) {
    expect(isTicket(value)).toBe(false)
  }
})
