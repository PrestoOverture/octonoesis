import { createHash } from 'node:crypto'
import { getProvider } from '../../providers/index.ts'
import type { CanonicalMessage, StreamEvent } from '../../providers/types.ts'

export type Fingerprint = {
  tool: string
  error_class: string
  file: string
  expression: string
  coarse: string // tool + error class
  medium: string // + repo-relative file
  fine: string // + stable detail skeleton
}

export const EXTRACTION_PROMPT_TEMPLATE = `You are a precise tool execution error analyzer.
Your task is to extract structured details from a failed tool execution's scrubbed output.
You MUST output a single, valid JSON object matching the schema below. Do not include markdown code block syntax (like \`\`\`json), trailing commas, or any conversational text.

Schema:
{
  "tool": "the name of the tool or test runner, e.g. 'bun-test', 'tsc', 'jest', 'eslint'",
  "error_class": "the error category or name, e.g. 'TypeError', 'SyntaxError', 'AttributeError'",
  "file": "the repo-relative file path where the error occurred, or an empty string if unknown",
  "expression": "the specific failing expression/detail, e.g. 'evaluating user.name' or empty string if unknown"
}

Failed Command: {COMMAND}
Scrubbed Error:
{SCRUBBED_ERROR}`

// Compute versioned prompt hash
export const PROMPT_HASH = createHash('sha256')
  .update(EXTRACTION_PROMPT_TEMPLATE)
  .digest('hex')
  .slice(0, 8)

/**
 * Extracts a three-level fingerprint from a scrubbed error output.
 * Queries the LLM provider for structured JSON extraction.
 * Falls back to offline heuristic parsing in case of failures.
 * @param scrubbed The scrubbed error output.
 * @param command The failed command that produced the error.
 * @param ctx The context object containing the model name.
 * @returns A promise resolving to the extracted Fingerprint object.
 */
export async function extractFingerprint(
  scrubbed: string,
  command: string,
  ctx: { model: string },
): Promise<Fingerprint> {
  const provider = getProvider()

  const userContent = EXTRACTION_PROMPT_TEMPLATE.replace('{COMMAND}', command).replace(
    '{SCRUBBED_ERROR}',
    scrubbed,
  )

  const messages: CanonicalMessage[] = [
    { role: 'user', content: [{ type: 'text', text: userContent }] },
  ]

  let responseText = ''
  const controller = new AbortController()

  try {
    const stream = provider.createMessageStream(messages, [], {
      model: ctx.model,
      maxTokens: 500,
      signal: controller.signal,
    })

    for await (const event of stream) {
      if (event.type === 'text_delta') {
        responseText += event.text
      }
    }
  } catch (error) {
    // LLM call failed or timed out, fall back to offline heuristic parsing
    return getFallbackFingerprint(scrubbed, command)
  }

  try {
    const cleanedJson = cleanJsonString(responseText)
    const data = JSON.parse(cleanedJson)

    const tool = (data.tool || getFallbackTool(command)).trim()
    const errorClass = (data.error_class || 'Error').trim()
    const file = (data.file || '').trim()
    const expression = (data.expression || '').trim()

    return assembleFingerprint(tool, errorClass, file, expression)
  } catch (e) {
    return getFallbackFingerprint(scrubbed, command)
  }
}

/**
 * Clean markdown tags and extraneous characters from LLM response to get a valid JSON string.
 * @param text The raw response text.
 * @returns The cleaned JSON string.
 */

function cleanJsonString(text: string): string {
  let cleaned = text.trim()
  // Strip markdown block formatting if present
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1)
  }
  return cleaned
}

/**
 * Derives a fallback tool name from the executable part of the command.
 * @param command The failed shell command.
 * @returns The extracted fallback tool name.
 */

function getFallbackTool(command: string): string {
  const parts = command.trim().split(/\s+/)
  if (!parts[0]) return 'bash'
  // Strip relative prefixes like ./bin/
  return parts[0].replace(/^.*\//, '')
}

/**
 * Extracts fallback fingerprint details using offline regex pattern matching.
 * @param scrubbed The scrubbed error output.
 * @param command The failed shell command.
 * @returns The parsed fallback Fingerprint.
 */

export function getFallbackFingerprint(scrubbed: string, command: string): Fingerprint {
  const tool = getFallbackTool(command)
  let errorClass = 'Error'

  // Search for common error class keywords (e.g. TypeError, SyntaxError, etc.)
  const match = scrubbed.match(/\b([A-Z][a-zA-Z0-9]*(?:Error|Exception))\b/)
  if (match?.[1]) {
    errorClass = match[1]
  }

  // Fallback cannot safely parse file and expression without risk of noise, so they are empty.
  return assembleFingerprint(tool, errorClass, '', '')
}

/**
 * Assembles a structured Fingerprint object from components, cleaning pipe characters.
 * @param tool The name of the tool.
 * @param errorClass The error class or category name.
 * @param file The file path where the error occurred.
 * @param expression The specific failing expression or detail.
 * @returns The assembled Fingerprint object.
 */

export function assembleFingerprint(
  tool: string,
  errorClass: string,
  file: string,
  expression: string,
): Fingerprint {
  // Replace pipe delimiters to prevent layout breakdown in downstream rules
  const cleanTool = tool.replace(/\|/g, '-')
  const cleanClass = errorClass.replace(/\|/g, '-')
  const cleanFile = file.replace(/\|/g, '-')
  const cleanExpr = expression.replace(/\|/g, '-')

  const coarse = `${cleanTool}|${cleanClass}`
  const medium = cleanFile ? `${coarse}|${cleanFile}` : coarse
  const fine = cleanExpr ? `${medium}|${cleanExpr}` : medium

  return {
    tool: cleanTool,
    error_class: cleanClass,
    file: cleanFile,
    expression: cleanExpr,
    coarse,
    medium,
    fine,
  }
}
