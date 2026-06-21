import { z } from 'zod'

export const toolEventSchema = z.object({
  kind: z.literal('tool'),
  tool: z.string(),
  input_digest: z.string(),
  outcome: z.enum(['success', 'failure']),
  error_class: z.string().nullable(),
  duration_ms: z.number(),
  path: z.string().optional(),
  cmd: z.string().optional(),
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
  kind: z.literal('permission'),
  decision: z.enum(['allow_once', 'allow_always', 'deny']),
  key: z.string(),
})

export const turnEventSchema = z.object({
  kind: z.literal('turn'),
  turn: z.number(),
})

export const sessionEventSchema = z.object({
  kind: z.literal('session'),
  exit_reason: z.enum(['completed', 'max_turns', 'fatal_error', 'user_cancel']),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
  model: z.string().optional(),
})

export const verifyEventSchema = z.object({
  kind: z.literal('verify'),
  verdict: z.enum(['PASS', 'FAIL', 'PARTIAL']),
  fingerprints: z.array(z.any()),
  command: z.string(),
  exit_code: z.number(),
  stale: z.boolean(),
})

export const userEventSchema = z.object({
  kind: z.literal('user'),
  digest: z.string(),
  cancel: z.boolean(),
})

export const journalEventSchema = z.discriminatedUnion('kind', [
  toolEventSchema,
  permissionEventSchema,
  turnEventSchema,
  sessionEventSchema,
  verifyEventSchema,
  userEventSchema,
])

export type JournalEvent = z.infer<typeof journalEventSchema>
