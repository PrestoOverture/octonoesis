export interface ProviderCredentials {
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
}

let capturedProviderCredentials: ProviderCredentials = {}

function credentialsFrom(source: NodeJS.ProcessEnv): ProviderCredentials {
  return {
    ...(source.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY } : {}),
    ...(source.OPENAI_API_KEY ? { OPENAI_API_KEY: source.OPENAI_API_KEY } : {}),
  }
}

/** Captures provider credentials in module state and removes them from the process environment. */
export function captureProviderCredentials(source: NodeJS.ProcessEnv = process.env): void {
  capturedProviderCredentials = credentialsFrom(source)
  Reflect.deleteProperty(source, 'ANTHROPIC_API_KEY')
  Reflect.deleteProperty(source, 'OPENAI_API_KEY')
}

/** Returns a copy suitable for the provider-only child processes that need credentials. */
export function getProviderCredentialEnvironment(): Record<string, string> {
  return { ...capturedProviderCredentials }
}

/** Test-only state seam for restoring credentials between isolated cases. */
export function setProviderCredentialsForTests(credentials: ProviderCredentials): void {
  capturedProviderCredentials = { ...credentials }
}

export function hasAnthropicKey(): boolean {
  return capturedProviderCredentials.ANTHROPIC_API_KEY !== undefined
}

export function hasOpenAIKey(): boolean {
  return capturedProviderCredentials.OPENAI_API_KEY !== undefined
}

/** Resolves the captured Anthropic API key, throwing if missing. */
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

/** Resolves the captured OpenAI API key, throwing if missing. */
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
