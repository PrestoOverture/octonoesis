/**
 * Determines whether a given error is a transient failure that is safe to retry.
 */
export function isRetriableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  const errObj = error as Record<string, unknown>

  // 1. Check HTTP status codes (for API SDK errors)
  if (typeof errObj.status === 'number') {
    const status = errObj.status
    if (status === 429 || (status >= 500 && status < 600)) {
      return true
    }
    return false
  }

  // 2. Check system network error codes
  const cause = errObj.cause
  const code =
    errObj.code ||
    (cause && typeof cause === 'object' && 'code' in cause
      ? (cause as Record<string, unknown>).code
      : undefined)
  if (typeof code === 'string') {
    const retriableCodes = [
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ENOTFOUND',
      'EPIPE',
      'ECONNREFUSED',
      'UND_ERR_CONNECT_TIMEOUT',
    ]
    if (retriableCodes.includes(code)) {
      return true
    }
  }

  // 3. Fallback check on message content
  const message = typeof errObj.message === 'string' ? errObj.message.toLowerCase() : ''
  if (
    message.includes('timeout') ||
    message.includes('rate limit') ||
    message.includes('connreset') ||
    message.includes('econnreset')
  ) {
    return true
  }

  return false
}
