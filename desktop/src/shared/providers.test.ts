import { expect, test } from 'bun:test'
import {
  type SecretStore,
  hostEnvironment,
  parseSavedSettings,
  providerSettings,
  validApiKey,
} from './providers'

function memoryStore(values: Record<string, string> = {}) {
  const reads: string[] = []
  const store: SecretStore = {
    get: async ({ name }) => {
      reads.push(name)
      return values[name] ?? null
    },
    set: async ({ name, value }) => {
      values[name] = value
    },
    delete: async ({ name }) => delete values[name],
  }
  return { store, reads }
}

test('API keys must be one non-empty line without whitespace or control characters', () => {
  expect(validApiKey('  sk-abc  ')).toBe('sk-abc')
  for (const bad of ['', '   ', 'a b', 'a\nb', 'a\u0000b', 'x'.repeat(4097), 42])
    expect(() => validApiKey(bad)).toThrow()
})

test('saved settings parse defensively', () => {
  expect(parseSavedSettings(null)).toEqual({ storedKeys: [] })
  expect(
    parseSavedSettings({ provider: 'bogus', storedKeys: ['spark', 'spark', 'nope', 3] }),
  ).toEqual({ storedKeys: ['spark'] })
  expect(parseSavedSettings({ provider: 'openai', storedKeys: [] })).toEqual({
    provider: 'openai',
    storedKeys: [],
  })
})

test('settings view reports key sources without reading the keychain', () => {
  expect(
    providerSettings(
      { provider: 'anthropic', storedKeys: ['spark', 'anthropic'] },
      { SPARK_API_KEY: 'env' },
    ),
  ).toEqual({
    provider: 'anthropic',
    providerFromEnvironment: false,
    keys: { spark: 'environment', anthropic: 'keychain', openai: 'none' },
  })
  expect(providerSettings({}, { LLM_PROVIDER: 'OpenAI' })).toMatchObject({
    provider: 'openai',
    providerFromEnvironment: true,
  })
})

test('host environment: launch environment wins, otherwise only the active key is read', async () => {
  const { store, reads } = memoryStore({ SPARK_API_KEY: 'chain', OPENAI_API_KEY: 'other' })
  expect(await hostEnvironment({ storedKeys: ['spark'] }, { PATH: '/bin' }, store)).toEqual({
    PATH: '/bin',
    LLM_PROVIDER: 'spark',
    SPARK_API_KEY: 'chain',
  })
  expect(reads).toEqual(['SPARK_API_KEY'])
  reads.length = 0
  expect(
    await hostEnvironment({ storedKeys: ['spark'] }, { SPARK_API_KEY: 'env' }, store),
  ).toMatchObject({ SPARK_API_KEY: 'env' })
  // Not recorded as stored: never touch the keychain.
  expect(await hostEnvironment({ provider: 'openai' }, {}, store)).toEqual({
    LLM_PROVIDER: 'openai',
  })
  expect(reads).toEqual([])
})
