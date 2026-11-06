export const PROVIDERS = {
  spark: { label: 'Spark', variable: 'SPARK_API_KEY' },
  anthropic: { label: 'Anthropic', variable: 'ANTHROPIC_API_KEY' },
  openai: { label: 'OpenAI', variable: 'OPENAI_API_KEY' },
} as const
export type Provider = keyof typeof PROVIDERS
export type KeySource = 'environment' | 'keychain' | 'none'
export type ProviderSettings = {
  provider: Provider
  /** True when LLM_PROVIDER in the launching environment overrides the saved choice. */
  providerFromEnvironment: boolean
  keys: Record<Provider, KeySource>
  error?: string
}

/** The subset of Bun.secrets the app uses, so tests can substitute an in-memory store. */
export type SecretStore = {
  get(options: { service: string; name: string }): Promise<string | null>
  set(options: { service: string; name: string; value: string }): Promise<void>
  delete(options: { service: string; name: string }): Promise<boolean>
}
export const KEYCHAIN_SERVICE = 'dev.octonoesis.desktop'

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && Object.hasOwn(PROVIDERS, value)
}

/** Rejects values that cannot be a single-line API key before they reach the keychain. */
export function validApiKey(value: unknown): string {
  if (typeof value !== 'string') throw new Error('API key must be text')
  const key = value.trim()
  if (!key) throw new Error('API key is empty')
  if (key.length > 4096 || /[\s\p{Cc}]/u.test(key))
    throw new Error('API key must be a single line without spaces')
  return key
}

/** Non-secret app settings; keys themselves live only in the keychain. */
export type SavedSettings = { provider?: Provider; storedKeys?: Provider[] }

export function parseSavedSettings(value: unknown): SavedSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    ...(isProvider(raw.provider) ? { provider: raw.provider } : {}),
    storedKeys: Array.isArray(raw.storedKeys)
      ? [...new Set(raw.storedKeys.filter(isProvider))]
      : [],
  }
}

export function activeProvider(
  saved: SavedSettings,
  env: Record<string, string | undefined>,
): Provider {
  const fromEnv = env.LLM_PROVIDER?.toLowerCase()
  if (isProvider(fromEnv)) return fromEnv
  return saved.provider ?? 'spark'
}

/** Settings view model. It never reads the keychain, so opening it cannot prompt. */
export function providerSettings(
  saved: SavedSettings,
  env: Record<string, string | undefined>,
): ProviderSettings {
  const keys = {} as Record<Provider, KeySource>
  for (const provider of Object.keys(PROVIDERS) as Provider[]) {
    keys[provider] = env[PROVIDERS[provider].variable]
      ? 'environment'
      : saved.storedKeys?.includes(provider)
        ? 'keychain'
        : 'none'
  }
  return {
    provider: activeProvider(saved, env),
    providerFromEnvironment: isProvider(env.LLM_PROVIDER?.toLowerCase()),
    keys,
  }
}

/**
 * Environment for one engine host: the launching environment wins; otherwise the active
 * provider and its keychain key are added. Only that provider's key is read.
 */
export async function hostEnvironment(
  saved: SavedSettings,
  env: Record<string, string | undefined>,
  store: SecretStore,
  service = KEYCHAIN_SERVICE,
): Promise<Record<string, string | undefined>> {
  const provider = activeProvider(saved, env)
  const { variable } = PROVIDERS[provider]
  const key =
    env[variable] ||
    (saved.storedKeys?.includes(provider) ? await store.get({ service, name: variable }) : null) ||
    undefined
  return { ...env, LLM_PROVIDER: provider, ...(key ? { [variable]: key } : {}) }
}
