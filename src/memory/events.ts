import { z } from 'zod'

const baseEventFields = {
  ts: z.string().optional(),
  session_id: z.string().optional(),
  schema_version: z.number().optional(),
}

export const toolEventSchema = z.object({
  ...baseEventFields,
  kind: z.literal('tool'),
  tool: z.string(),
  input_digest: z.string(),
  outcome: z.enum(['success', 'failure']),
  error_class: z.string().nullable(),
  duration_ms: z.number(),
  path: z.string().optional(),
  cmd: z.string().optional(),
  sandboxed: z.boolean().optional(),
  exit_code: z.number().optional(),
  fingerprints: z
    .array(
      z.object({
        tool: z.string().optional(),
        error_class: z.string().optional(),
        file: z.string().optional(),
        expression: z.string().optional(),
        coarse: z.string(),
        medium: z.string(),
        fine: z.string(),
      }),
    )
    .optional(),
})

export const permissionEventSchema = z.object({
  ...baseEventFields,
  kind: z.literal('permission'),
  decision: z.enum(['allow_once', 'allow_always', 'deny']),
  key: z.string(),
  via: z.literal('config').optional(),
})

export const turnEventSchema = z.object({
  ...baseEventFields,
  kind: z.literal('turn'),
  turn: z.number(),
})

export const sessionEventSchema = z.object({
  ...baseEventFields,
  kind: z.literal('session'),
  exit_reason: z.enum([
    'completed',
    'max_turns',
    'fatal_error',
    'user_cancel',
    'budget_exceeded',
    'prompt_too_long',
  ]),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
  model: z.string().optional(),
})

export const verifyEventSchema = z.object({
  ...baseEventFields,
  kind: z.literal('verify'),
  verdict: z.enum(['PASS', 'FAIL', 'PARTIAL']),
  fingerprints: z.array(z.any()),
  command: z.string(),
  exit_code: z.number(),
  stale: z.boolean(),
})

export const userEventSchema = z.object({
  ...baseEventFields,
  kind: z.literal('user'),
  digest: z.string(),
  cancel: z.boolean(),
})

export const compactEventSchema = z.object({
  ...baseEventFields,
  kind: z.literal('compact'),
  pre_tokens: z.number(),
  post_tokens: z.number(),
  summary_length: z.number(),
})

export const memoryWriteEventSchema = z.object({
  ...baseEventFields,
  kind: z.literal('memory_write'),
  name: z.string(),
  type: z.enum(['user', 'feedback', 'project', 'reference']),
  action: z.enum(['create', 'update', 'delete']),
})

export const skillEventSchema = z.object({
  ...baseEventFields,
  kind: z.literal('skill'),
  skill: z.string(),
  context: z.enum(['inline', 'fork']),
  duration_ms: z.number(),
})

export const taskEventSchema = z.object({
  ...baseEventFields,
  kind: z.literal('task'),
  task_id: z.string(),
  type: z.enum(['shell', 'agent']),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'killed']),
  duration_ms: z.number().optional(),
})

export const hookEventSchema = z.object({
  ...baseEventFields,
  kind: z.literal('hook'),
  hook_event: z.string(),
  hook_type: z.enum(['shell', 'prompt', 'function']),
  duration_ms: z.number(),
  outcome: z.enum(['success', 'failure', 'timeout']),
})

export const journalEventSchema = z.discriminatedUnion('kind', [
  toolEventSchema,
  permissionEventSchema,
  turnEventSchema,
  sessionEventSchema,
  verifyEventSchema,
  userEventSchema,
  compactEventSchema,
  memoryWriteEventSchema,
  skillEventSchema,
  taskEventSchema,
  hookEventSchema,
])

export type JournalEvent = z.infer<typeof journalEventSchema>

export const EVENT_SCHEMA_VERSIONS: Record<JournalEvent['kind'], 1 | 2> = {
  tool: 1,
  permission: 1,
  turn: 1,
  session: 1,
  verify: 1,
  user: 1,
  compact: 2,
  memory_write: 2,
  skill: 2,
  task: 2,
  hook: 2,
}

const unknownJournalEventSchema = z.object({ kind: z.string() }).passthrough()

export type UnknownJournalEvent = z.infer<typeof unknownJournalEventSchema>

export function parseJournalEvent(raw: unknown): JournalEvent | UnknownJournalEvent | null {
  const known = journalEventSchema.safeParse(raw)
  if (known.success) return known.data

  const unknown = unknownJournalEventSchema.safeParse(raw)
  return unknown.success ? unknown.data : null
}

export function isKnownJournalEvent(
  event: JournalEvent | UnknownJournalEvent,
): event is JournalEvent {
  return Object.hasOwn(EVENT_SCHEMA_VERSIONS, event.kind)
}
