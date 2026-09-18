/** Holds optional API keys for supported LLM providers (Anthropic, OpenAI). */
export interface ProviderCredentials {
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
}

let capturedProviderCredentials: ProviderCredentials = {}

/**
 * Extracts provider API keys from a process environment record into a typed credentials object.
 * @param source The process environment object.
 * @returns An object containing available provider API keys.
 */
function credentialsFrom(source: NodeJS.ProcessEnv): ProviderCredentials {
  return {
    ...(source.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY } : {}),
    ...(source.OPENAI_API_KEY ? { OPENAI_API_KEY: source.OPENAI_API_KEY } : {}),
  }
}

/**
 * Captures provider credentials in module state and removes them from the process environment
 * to prevent accidental exposure to untrusted child processes.
 * @param source Optional process environment object; defaults to process.env.
 */
export function captureProviderCredentials(source: NodeJS.ProcessEnv = process.env): void {
  capturedProviderCredentials = credentialsFrom(source)
  Reflect.deleteProperty(source, 'ANTHROPIC_API_KEY')
  Reflect.deleteProperty(source, 'OPENAI_API_KEY')
}

/**
 * Returns a copy of the captured credentials suitable for provider-only child processes.
 * @returns A record containing the captured provider API keys.
 */
export function getProviderCredentialEnvironment(): Record<string, string> {
  return { ...capturedProviderCredentials }
}

/**
 * Overrides captured credentials for test isolation.
 * @param credentials The mock or test credentials to set.
 */
export function setProviderCredentialsForTests(credentials: ProviderCredentials): void {
  capturedProviderCredentials = { ...credentials }
}

/**
 * Checks whether an Anthropic API key has been captured and is available.
 * @returns True if an Anthropic API key is set, false otherwise.
 */
export function hasAnthropicKey(): boolean {
  return capturedProviderCredentials.ANTHROPIC_API_KEY !== undefined
}

/**
 * Checks whether an OpenAI API key has been captured and is available.
 * @returns True if an OpenAI API key is set, false otherwise.
 */
export function hasOpenAIKey(): boolean {
  return capturedProviderCredentials.OPENAI_API_KEY !== undefined
}

/**
 * Resolves the captured Anthropic API key.
 * @returns The Anthropic API key string.
 * @throws {Error} If ANTHROPIC_API_KEY is not set.
 */
export function getAnthropicKey(): string {
  const key = capturedProviderCredentials.ANTHROPIC_API_KEY
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. ' +
        'Export it in your shell or add it to a .env file: \n\n' +
        'export ANTHROPIC_API_KEY=sk-ant-...',
    )
  }
  return key
}

/**
 * Resolves the captured OpenAI API key.
 * @returns The OpenAI API key string.
 * @throws {Error} If OPENAI_API_KEY is not set.
 */
export function getOpenAIKey(): string {
  const key = capturedProviderCredentials.OPENAI_API_KEY
  if (!key) {
    throw new Error(
      'OPENAI_API_KEY is not set. ' +
        'Export it in your shell or add it to a .env file: \n\n' +
        'export OPENAI_API_KEY=sk-proj-...',
    )
  }
  return key
}

captureProviderCredentials()
