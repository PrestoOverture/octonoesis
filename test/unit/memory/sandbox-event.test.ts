import { describe, expect, it } from 'bun:test'
import { isKnownJournalEvent, parseJournalEvent } from '../../../src/memory/events'

describe('sandbox tool journal metadata', () => {
  it('round-trips the optional sandboxed field through parseJournalEvent', () => {
    for (const sandboxed of [true, false]) {
      const parsed = parseJournalEvent({
        kind: 'tool',
        tool: 'Bash',
        input_digest: 'digest',
        outcome: 'success',
        error_class: null,
        duration_ms: 1,
        sandboxed,
      })

      expect(parsed === null).toBe(false)
      if (parsed && isKnownJournalEvent(parsed) && parsed.kind === 'tool') {
        expect(parsed.sandboxed).toBe(sandboxed)
      } else {
        throw new Error('tool event did not parse as a known event')
      }
    }
  })
})
