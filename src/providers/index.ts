import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './anthropic'
import { DEFAULT_OPENAI_MODEL, OpenAIProvider } from './openai'
import type { LLMProvider } from './types'

export * from './types'
export { DEFAULT_ANTHROPIC_MODEL } from './anthropic'
export { DEFAULT_OPENAI_MODEL } from './openai'

let activeProvider: LLMProvider | null = null

/**
 * Resolves the configured provider instance based on LLM_PROVIDER.
 * Defaults to 'anthropic'.
 *
 * @return The resolved LLMProvider instance.
 */
export function getProvider(): LLMProvider {
  if (activeProvider) return activeProvider

  const providerEnv = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase()
  if (providerEnv === 'anthropic') {
    activeProvider = new AnthropicProvider()
  } else if (providerEnv === 'openai') {
    activeProvider = new OpenAIProvider()
  } else {
    throw new Error(
      `Unsupported LLM_PROVIDER: "${process.env.LLM_PROVIDER}". Supported values are "anthropic" or "openai".`,
    )
  }

  return activeProvider
}

/**
 * Overrides the provider instance. Useful for mock injection during tests.
 *
 * @param provider The provider override instance or null.
 */
export function setProvider(provider: LLMProvider | null): void {
  activeProvider = provider
}

/**
 * Resolves the active model ID based on env configuration priorities:
 * MODEL > provider-specific model env var > default model constant.
 *
 * @return The resolved model name.
 */
export function getResolvedModel(): string {
  const providerEnv = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase()

  if (process.env.MODEL) {
    return process.env.MODEL
  }

  if (providerEnv === 'anthropic') {
    return process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL
  }
  if (providerEnv === 'openai') {
    return process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL
  }

  return DEFAULT_ANTHROPIC_MODEL
}

/**
 * Resolves the provider's cheapest available model ID (Haiku-tier/nano-tier).
 * Bypasses general MODEL overrides to enforce cheap distillation context operations.
 * @returns The cheapest available model ID.
 */
export function getCheapestModel(): string {
  const providerEnv = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase()
  if (providerEnv === 'openai') {
    return DEFAULT_OPENAI_MODEL
  }
  return DEFAULT_ANTHROPIC_MODEL
}
