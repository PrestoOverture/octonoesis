import { dbg } from './debug'
import { isRetriableError } from './errors'

export interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  signal?: AbortSignal
}

/**
 * Wraps an AsyncGenerator-producing function with exponential backoff retry.
 * Only retries if the failure occurs before the first element is yielded.
 */
export async function* withRetryGenerator<T>(
  fn: () => AsyncGenerator<T, void, undefined>,
  opts: RetryOptions = {},
): AsyncGenerator<T, void, undefined> {
  const maxAttempts = opts.maxAttempts ?? 5
  const baseDelayMs = opts.baseDelayMs ?? 500
  const maxDelayMs = opts.maxDelayMs ?? 30000
  const signal = opts.signal

  let attempt = 0
  let hasYielded = false

  while (true) {
    attempt++
    if (signal?.aborted) {
      throw new Error('Aborted prior to connection attempt')
    }

    let iterator: AsyncGenerator<T, void, undefined> | null = null
    try {
      iterator = fn()

      // Manually drive the iterator to intercept errors on the first next() call
      let nextResult = await iterator.next()

      while (!nextResult.done) {
        hasYielded = true
        yield nextResult.value
        nextResult = await iterator.next()
      }
      return // Completed successfully!
    } catch (err: unknown) {
      if (hasYielded || attempt >= maxAttempts || !isRetriableError(err)) {
        throw err
      }

      if (signal?.aborted) {
        throw new Error('Aborted during retry loop')
      }

      // Calculate exponential backoff delay with jitter
      const base = baseDelayMs
      const cap = maxDelayMs
      let backoffMs = Math.min(cap, base * 2 ** (attempt - 1))

      if (err && typeof err === 'object') {
        const errObj = err as Record<string, unknown>
        const headers = errObj.headers as Record<string, unknown> | undefined
        if (
          errObj.status === 429 &&
          headers &&
          (typeof headers['retry-after'] === 'string' || typeof headers['retry-after'] === 'number')
        ) {
          const retryAfter = Number.parseFloat(String(headers['retry-after']))
          if (!Number.isNaN(retryAfter)) {
            backoffMs = retryAfter * 1000
          }
        }
      }

      const jitter = 0.5 + Math.random() * 0.5
      const delayMs = Math.round(backoffMs * jitter)

      dbg(
        'retry',
        `Attempt ${attempt} failed. Retrying in ${delayMs}ms. Error: ${err instanceof Error ? err.message : String(err)}`,
      )

      // Wait for delayMs or until signal is aborted
      await new Promise<void>((resolve, reject) => {
        let timeoutId: ReturnType<typeof setTimeout> | undefined = undefined
        const onAbort = () => {
          if (timeoutId) clearTimeout(timeoutId)
          reject(new Error('Aborted during retry delay'))
        }

        if (signal?.aborted) {
          return onAbort()
        }

        timeoutId = setTimeout(() => {
          if (signal) {
            signal.removeEventListener('abort', onAbort)
          }
          resolve()
        }, delayMs)

        if (signal) {
          signal.addEventListener('abort', onAbort)
        }
      })
    }
  }
}
