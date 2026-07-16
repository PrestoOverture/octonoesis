import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  captureProviderCredentials,
  getAnthropicKey,
  getOpenAIKey,
  getProviderCredentialEnvironment,
  setProviderCredentialsForTests,
} from '../../../src/utils/env'

const originalEnv = {
  anthropic: process.env.ANTHROPIC_API_KEY,
  openai: process.env.OPENAI_API_KEY,
}
const originalCredentials = getProviderCredentialEnvironment()

beforeEach(() => {
  Reflect.deleteProperty(process.env, 'ANTHROPIC_API_KEY')
  Reflect.deleteProperty(process.env, 'OPENAI_API_KEY')
  setProviderCredentialsForTests({})
})

afterEach(() => {
  if (originalEnv.anthropic === undefined) {
    Reflect.deleteProperty(process.env, 'ANTHROPIC_API_KEY')
  } else {
    process.env.ANTHROPIC_API_KEY = originalEnv.anthropic
  }
  if (originalEnv.openai === undefined) {
    Reflect.deleteProperty(process.env, 'OPENAI_API_KEY')
  } else {
    process.env.OPENAI_API_KEY = originalEnv.openai
  }
  setProviderCredentialsForTests(originalCredentials)
})

describe('provider credential capture', () => {
  it('captures both keys, removes them from process.env, and serves provider reads', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
    process.env.OPENAI_API_KEY = 'sk-openai-test-key'

    captureProviderCredentials()

    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(getAnthropicKey()).toBe('sk-ant-test-key')
    expect(getOpenAIKey()).toBe('sk-openai-test-key')
  })

  it('throws friendly provider-specific errors when captured keys are missing', () => {
    expect(() => getAnthropicKey()).toThrow('ANTHROPIC_API_KEY is not set')
    expect(() => getOpenAIKey()).toThrow('OPENAI_API_KEY is not set')
  })
})
