/**
 * Environment variable helpers.
 * Bun auto-loads .env at the beginning, so no dotenv is nedded.
 * Checks whether the key is set, otherwise throws an error
 * @returns Anthropic API key
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
