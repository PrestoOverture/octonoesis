import crypto from 'node:crypto'
import { appendJournal } from '../memory/journal'
import { requestPermission } from '../permissions/confirm'
import { preToolUseHook } from '../permissions/hooks'
import type { ToolContext, ToolResult } from './Tool'
import { getTool } from './registry'

/**
 * Executes a tool by resolving it, validating input, running hooks, checking permissions, and calling the tool.
 * @param name The name of the tool to run.
 * @param rawInput The unvalidated input arguments.
 * @param ctx The tool execution context.
 * @returns A promise resolving to the ToolResult from the execution.
 */
export async function runTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const startTime = performance.now()
  const inputDigest = crypto.createHash('sha256').update(JSON.stringify(rawInput)).digest('hex')

  const getResult = async (): Promise<ToolResult> => {
    // 1. Resolve tool from registry
    const tool = getTool(name)
    if (!tool) {
      return { ok: false, error: `unknown_tool: Tool "${name}" is not registered.` }
    }

    // 2. Validate input shape via Zod
    let validatedInput: unknown
    try {
      const parseResult = tool.inputSchema.safeParse(rawInput)
      if (!parseResult.success) {
        const errorMsg = parseResult.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')
        return { ok: false, error: `invalid_input: ${errorMsg}` }
      }
      validatedInput = parseResult.data
    } catch (err) {
      return {
        ok: false,
        error: `schema_validation_error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    // 3. Run PreToolUse Hook (placeholder for security filters / auto-moderation)
    try {
      const hookResult = await preToolUseHook(name, validatedInput, ctx)
      if (hookResult.action === 'deny') {
        return {
          ok: false,
          error: `permission_denied: ${hookResult.reason ?? 'Pre-tool check rejected execution.'}`,
        }
      }
      if (hookResult.action === 'modify' && hookResult.modifiedInput !== undefined) {
        validatedInput = hookResult.modifiedInput
      }
    } catch (err) {
      return {
        ok: false,
        error: `pre_tool_hook_error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    // 4. Permission Decision Gate
    const isReadOnly = tool.isReadOnly(validatedInput)
    if (!isReadOnly) {
      try {
        const decision = await requestPermission(name, validatedInput, ctx)
        if (decision === 'deny') {
          return { ok: false, error: 'permission_denied: User denied execution.' }
        }
      } catch (err) {
        return {
          ok: false,
          error: `permission_request_error: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }

    // 5. Execute actual tool callback
    try {
      if (ctx.abortSignal?.aborted) {
        return { ok: false, error: 'aborted: Operation cancelled by user.' }
      }
      return await tool.call(validatedInput, ctx)
    } catch (err) {
      return {
        ok: false,
        error: `tool_execution_error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  const result = await getResult()
  const durationMs = Math.round(performance.now() - startTime)
  const errorClass = result.ok ? null : result.error.split(':')[0] || 'unknown_error'

  appendJournal({
    kind: 'tool',
    tool: name,
    input_digest: inputDigest,
    outcome: result.ok ? 'success' : 'failure',
    error_class: errorClass,
    duration_ms: durationMs,
  })

  return result
}
