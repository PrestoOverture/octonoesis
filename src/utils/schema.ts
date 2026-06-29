import z from 'zod'

/**
 * A lightweight, dependency-free utility to convert Zod Object schemas
 * into standard JSON Schema draft-7 formats, as expected by the Anthropic and OpenAI APIs.
 *
 * @param schema The ZodObject schema to convert.
 * @return The converted JSON Schema draft-7 object.
 */
// biome-ignore lint/suspicious/noExplicitAny: Zod 4 internal type mapping bypass
export function zodToJsonSchema(schema: any): any {
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {}
    const required: string[] = []

    for (const [key, propSchema] of Object.entries(schema.shape)) {
      let isOptional = false
      // biome-ignore lint/suspicious/noExplicitAny: Zod 4 internal type mapping bypass
      let innerSchema = propSchema as any

      // Unwrap ZodOptional if present
      if (innerSchema instanceof z.ZodOptional) {
        isOptional = true
        innerSchema = innerSchema.unwrap()
      }

      if (!isOptional) {
        required.push(key)
      }

      // Convert standard primitive Zod types
      if (innerSchema instanceof z.ZodString) {
        properties[key] = {
          type: 'string',
          description: innerSchema.description ?? undefined,
        }
      } else if (innerSchema instanceof z.ZodNumber) {
        properties[key] = {
          type: 'number',
          description: innerSchema.description ?? undefined,
        }
      } else if (innerSchema instanceof z.ZodBoolean) {
        properties[key] = {
          type: 'boolean',
          description: innerSchema.description ?? undefined,
        }
      } else if (innerSchema instanceof z.ZodArray) {
        properties[key] = {
          type: 'array',
          items: zodToJsonSchema(innerSchema.element),
          description: innerSchema.description ?? undefined,
        }
      } else if (innerSchema instanceof z.ZodEnum) {
        properties[key] = {
          type: 'string',
          enum: innerSchema.options,
          description: innerSchema.description ?? undefined,
        }
      } else {
        // Fallback for any other custom schemas
        properties[key] = {
          type: 'string',
          description: innerSchema.description ?? undefined,
        }
      }
    }

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    }
  }

  return { type: 'string' }
}
