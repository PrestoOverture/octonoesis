import type { CanonicalMessage } from '../providers/types'
import {
  type CompactOpts,
  type CompactResult,
  compact,
  createCompactSummaryMessage,
} from './compact'

export type BackgroundCompactOutcome = { result: CompactResult } | { error: unknown }

/** Owns one immutable snapshot and one cancellable summary job; never mutates live history. */
export class BackgroundCompaction {
  readonly startedAt = performance.now()
  private readonly source: CanonicalMessage[]
  private readonly controller = new AbortController()
  private readonly completion: Promise<BackgroundCompactOutcome>
  private outcome?: BackgroundCompactOutcome

  constructor(messages: CanonicalMessage[], opts: CompactOpts, run: typeof compact = compact) {
    this.source = structuredClone(messages)
    const abort = () => this.controller.abort()
    if (opts.signal?.aborted) abort()
    else opts.signal?.addEventListener('abort', abort, { once: true })
    this.completion = Promise.resolve()
      .then(() =>
        run(this.source, {
          ...opts,
          snapshot: opts.snapshot ? { ...opts.snapshot } : undefined,
          signal: this.controller.signal,
          recordEvent: false,
        }),
      )
      .then(
        (result) => {
          this.outcome = { result }
          return this.outcome
        },
        (error) => {
          this.outcome = { error }
          return this.outcome
        },
      )
      .finally(() => opts.signal?.removeEventListener('abort', abort))
  }

  /** At the hard threshold callers await; below it they only poll a settled result. */
  async poll(wait: boolean): Promise<BackgroundCompactOutcome | undefined> {
    return wait ? this.completion : this.outcome
  }

  replacement(messages: CanonicalMessage[], result: CompactResult): CanonicalMessage[] | undefined {
    if (
      messages.length < this.source.length ||
      this.source.some(
        (message, index) => JSON.stringify(message) !== JSON.stringify(messages[index]),
      )
    )
      return undefined
    return [
      result.pinnedHead,
      createCompactSummaryMessage(result.summary),
      ...result.messagesKept,
      ...messages.slice(this.source.length),
    ]
  }

  async cancel(): Promise<void> {
    this.controller.abort()
    await this.completion
  }
}
