/**
 * Resolves the Anthropic API key from the environment variables, throwing an error if missing.
 * @returns The resolved Anthropic API key string.
 */
export function getAnthropicKey(): string {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. ' +
        'Export it in your shell or add it to a .env file: \n\n' +
        'export ANTHROPIC_API_KEY=sk-ant-...',
    )
  }
  return key
}
