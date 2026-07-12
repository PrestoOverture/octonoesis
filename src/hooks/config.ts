import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { ConfigValidationError, hookSchema } from '../config/schema'

export type ConfiguredHook = z.infer<typeof hookSchema>

function formatHookIssues(error: z.ZodError): string[] {
  return error.issues.flatMap((issue) => {
    const parent = ['hooks', ...issue.path.map(String)]
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => `${[...parent, key].join('.')}: unrecognized key`)
    }
    return [`${parent.join('.')}: ${issue.message}`]
  })
}

export async function loadHooksConfig(repoRoot: string): Promise<ConfiguredHook[]> {
  const configPath = path.join(repoRoot, '.octonoesis', 'config.json')
  let raw: string
  try {
    raw = await fs.readFile(configPath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }

  let config: unknown
  try {
    config = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `${configPath}: invalid JSON: ${error instanceof Error ? error.message : error}`,
    )
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new ConfigValidationError(['hooks: config root must be an object'])
  }
  if (!('hooks' in config)) return []

  const parsed = z.array(hookSchema).safeParse((config as { hooks?: unknown }).hooks)
  if (!parsed.success) throw new ConfigValidationError(formatHookIssues(parsed.error))
  return parsed.data
}
