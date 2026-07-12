import { z } from 'zod'

const positiveIntegerSchema = z
  .number({ error: 'expected positive integer' })
  .int({ error: 'expected positive integer' })
  .positive({ error: 'expected positive integer' })

const nonNegativeIntegerSchema = z
  .number({ error: 'expected non-negative integer' })
  .int({ error: 'expected non-negative integer' })
  .nonnegative({ error: 'expected non-negative integer' })

const nonEmptyStringSchema = z.string().min(1, { error: 'expected non-empty string' })

const filesystemSchema = z
  .object({
    allowWrite: z.array(z.string()).optional(),
    denyRead: z.array(z.string()).optional(),
  })
  .strict()

const networkSchema = z
  .object({
    allowedDomains: z.array(z.string()).optional(),
  })
  .strict()

const sandboxSchema = z
  .object({
    enabled: z.boolean().default(false),
    filesystem: filesystemSchema.optional(),
    network: networkSchema.optional(),
  })
  .strict()

const mcpServerSchema = z
  .object({
    command: nonEmptyStringSchema,
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    timeout: positiveIntegerSchema.default(5000),
  })
  .strict()

export const hookSchema = z
  .object({
    event: z.enum([
      'pre_tool_use',
      'post_tool_use',
      'stop',
      'session_start',
      'session_end',
      'compact',
    ]),
    toolPattern: z.string().optional(),
    command: nonEmptyStringSchema,
  })
  .strict()

const permissionPatternSchema = z
  .string()
  .refine(
    (pattern) =>
      /^[A-Za-z][A-Za-z0-9_]*$/.test(pattern) ||
      (pattern.startsWith('Bash(') &&
        pattern.endsWith('*)') &&
        !/[()*]/.test(pattern.slice(5, -2))),
    { error: 'expected a bare tool name or Bash(prefix*)' },
  )

const permissionsSchema = z
  .object({
    allowPatterns: z.array(permissionPatternSchema).default([]),
    denyPatterns: z.array(permissionPatternSchema).default([]),
  })
  .strict()

const compactionSchema = z
  .object({
    cooldownTurns: nonNegativeIntegerSchema.default(0),
    minShrinkPercent: z.number().min(0).max(100).default(0),
  })
  .strict()

export const octonoesisConfigSchema = z
  .object({
    model: z.string().optional(),
    maxTurns: positiveIntegerSchema.default(50),
    sandbox: sandboxSchema.default({ enabled: false }),
    mcpServers: z.record(z.string(), mcpServerSchema).default({}),
    hooks: z.array(hookSchema).default([]),
    permissions: permissionsSchema.default({ allowPatterns: [], denyPatterns: [] }),
    projectInstructions: z.enum(['on', 'off']).default('on'),
    compaction: compactionSchema.default({ cooldownTurns: 0, minShrinkPercent: 0 }),
    trustTrackedConfig: z.boolean().default(false),
  })
  .strict()

export type OctonoesisConfig = z.infer<typeof octonoesisConfigSchema>

export const DEFAULT_CONFIG: OctonoesisConfig = octonoesisConfigSchema.parse({})

export class ConfigValidationError extends Error {
  constructor(issues: string[]) {
    super(`Invalid Octonoesis config:\n${issues.join('\n')}`)
    this.name = 'ConfigValidationError'
  }
}

export function parseConfig(raw: unknown): OctonoesisConfig {
  const parsed = octonoesisConfigSchema.safeParse(raw === undefined ? {} : raw)
  if (parsed.success) return parsed.data

  const issues = parsed.error.issues.flatMap((issue) => {
    const parentPath = issue.path.map(String)
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => `${[...parentPath, key].join('.')}: unrecognized key`)
    }

    const path = parentPath.length > 0 ? parentPath.join('.') : 'config'
    return [`${path}: ${issue.message}`]
  })

  throw new ConfigValidationError(issues)
}
