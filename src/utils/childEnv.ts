export const SHELL_API_KEY_INHERIT_ENV = 'OCTONOESIS_INHERIT_API_KEYS'

const SHELL_CREDENTIAL_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const

function isTruthy(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

/** Builds a shell child environment with provider credentials removed unless explicitly allowed. */
export function shellChildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value
  }

  if (!isTruthy(env[SHELL_API_KEY_INHERIT_ENV])) {
    for (const key of SHELL_CREDENTIAL_KEYS) delete env[key]
  }
  return env
}
