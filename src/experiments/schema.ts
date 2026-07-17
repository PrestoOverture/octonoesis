import { z } from 'zod'

/** ISO 8601 datetime string, validated by successful Date parsing (mirrors state/sessionStore.ts). */
const isoDateTimeSchema = z.string().refine((value) => !Number.isNaN(new Date(value).getTime()), {
  error: 'expected an ISO 8601 datetime string',
})

const nonEmptyStringSchema = z.string().min(1, { error: 'expected a non-empty string' })

const experimentArmSchema = z
  .object({
    name: nonEmptyStringSchema,
    prompt_hashes: z.array(z.string()),
  })
  .strict()

const experimentArmsSchema = z
  .array(experimentArmSchema)
  .min(2, { error: 'expected at least 2 arms' })
  .refine((arms) => new Set(arms.map((arm) => arm.name)).size === arms.length, {
    error: 'arm names must be unique',
  })

const experimentRecordShape = z
  .object({
    schema_version: z.literal(1),
    id: z.string().regex(/^exp-[a-z0-9-]+$/, {
      error: 'expected an id matching ^exp-[a-z0-9-]+$',
    }),
    registered_at: isoDateTimeSchema,
    hypothesis: nonEmptyStringSchema,
    endpoints: z
      .object({
        primary: nonEmptyStringSchema,
        secondary: z.array(z.string()),
      })
      .strict(),
    test: z
      .object({
        method: z.string(),
        pass_line: z.string(),
      })
      .strict(),
    arms: experimentArmsSchema.optional(),
    status: z.enum(['registered', 'running', 'concluded']),
    result: z.string().optional(),
    decision: z.string().optional(),
    concluded_at: isoDateTimeSchema.optional(),
  })
  .strict()

/**
 * Preregistration registry record (schema_version 1). A `concluded` record must carry
 * `result`, `decision`, and `concluded_at` — enforced below, not by field optionality alone.
 */
export const experimentRecordSchema = experimentRecordShape.refine(
  (record) =>
    record.status !== 'concluded' ||
    (record.result !== undefined &&
      record.decision !== undefined &&
      record.concluded_at !== undefined),
  { error: 'concluded experiments require result, decision, and concluded_at' },
)

export type ExperimentRecord = z.infer<typeof experimentRecordSchema>
export type ExperimentArm = ExperimentRecord['arms'] extends (infer Arm)[] | undefined ? Arm : never
