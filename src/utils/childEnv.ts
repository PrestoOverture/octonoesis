import { getProviderCredentialEnvironment } from './env.ts'

export const SHELL_API_KEY_INHERIT_ENV = 'OCTONOESIS_INHERIT_API_KEYS'

const SHELL_CREDENTIAL_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const

/**
 * Checks whether an environment variable string represents a truthy flag.
 * @param value The raw environment variable string value.
 * @returns True if the value is truthy ('1', 'true', 'yes', 'on', case-insensitive), false otherwise.
 */
function isTruthy(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

/**
 * Builds a sanitized child environment record for shell execution.
 * By default, strips sensitive LLM provider API credentials unless OCTONOESIS_INHERIT_API_KEYS is truthy.
 * @param source Optional source environment record; defaults to process.env.
 * @returns A new environment object suitable for child process spawning.
 */
export function shellChildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value
  }

  if (isTruthy(env[SHELL_API_KEY_INHERIT_ENV])) {
    Object.assign(env, getProviderCredentialEnvironment())
  } else {
    for (const key of SHELL_CREDENTIAL_KEYS) delete env[key]
  }
  return env
}
