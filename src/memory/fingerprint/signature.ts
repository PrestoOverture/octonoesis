/** Canonical runner spelling; retain the error, file and detail verbatim. */
export function normalizeTool(tool: string): string {
  return tool.trim().replace(/\s+/g, '-')
}

/** Also applies to persisted signatures produced before runner normalization. */
export function normalizeSignature(signature: string): string {
  const separator = signature.indexOf('|')
  if (separator === -1) return signature
  return normalizeTool(signature.slice(0, separator)) + signature.slice(separator)
}
