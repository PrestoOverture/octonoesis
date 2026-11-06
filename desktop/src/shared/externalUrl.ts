/** Both the webview and privileged main process enforce this URL boundary. */
export function externalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href
  } catch {
    // Relative paths and malformed URLs are never sent to the system opener.
  }
  return undefined
}
