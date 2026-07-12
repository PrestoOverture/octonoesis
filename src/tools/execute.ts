import crypto from 'node:crypto'
import { defaultCachedExtractor } from '../memory/fingerprint/cache'
import type { Fingerprint } from '../memory/fingerprint/extract'
import { scrub } from '../memory/fingerprint/scrub'
import { appendJournal } from '../memory/journal'
import { type VerifyResult, verify } from '../memory/verifier'
import { requestPermission } from '../permissions/confirm'
import { preToolUseHook } from '../permissions/hooks'
import { getResolvedModel } from '../providers/index'
import type { QueryLoopContext } from '../query/types'
import type { ToolResult } from './Tool'
import { getTool } from './registry'

/**
 * Checks if a command matches common verification tool patterns (e.g. test, lint, check, compile).
 * @param command The shell command to check.
 * @param verificationCommand Optional specific command string designated for verification.
 * @returns True if the command is classified as a verification command, false otherwise.
 */
export function isVerificationCommand(command: string, verificationCommand?: string): boolean {
  if (verificationCommand && command === verificationCommand) {
    return true
  }

  // Pre-process: replace parentheses with spaces to handle subshells (e.g. (cd foo && bun test))
  const normalizedCommand = command.replace(/[\(\)]/g, ' ')

  // Split by common shell execution chain operators: &&, ||, ;, and |
  const segments = normalizedCommand.split(/&&|\|\||;|\|/)

  for (const segment of segments) {
    const trimmed = segment.trim()
    if (!trimmed) continue

    const tokens = trimmed.split(/\s+/)
    if (tokens.length === 0) continue

    // Filter out leading env vars (e.g. VAR=value)
    let startIndex = 0
    while (startIndex < tokens.length) {
      const t = tokens[startIndex]
      if (t?.includes('=')) {
        startIndex++
      } else {
        break
      }
    }
    const cleanTokens = tokens.slice(startIndex)
    if (cleanTokens.length === 0) continue

    // Helper to recursively strip common prefix wrappers (npx, poetry run, etc)
    const stripWrappers = (toks: string[]): string[] => {
      if (toks.length === 0) return toks
      const first = toks[0]
      if (first === 'npx' || first === 'bunx') {
        return stripWrappers(toks.slice(1))
      }
      if (
        toks.length >= 2 &&
        first &&
        (first === 'bun' ||
          first === 'npm' ||
          first === 'pnpm' ||
          first === 'yarn' ||
          first === 'poetry' ||
          first === 'pipenv') &&
        toks[1] === 'run'
      ) {
        return stripWrappers(toks.slice(2))
      }
      return toks
    }

    const finalTokens = stripWrappers(cleanTokens)
    if (finalTokens.length === 0) continue

    const firstToken = finalTokens[0]
    if (!firstToken) continue

    const isVerifierWord = (word: string): boolean => {
      return (
        word === 'test' ||
        word.startsWith('test:') ||
        word === 'check' ||
        word.startsWith('check:') ||
        word === 'lint' ||
        word.startsWith('lint:') ||
        word === 'compile' ||
        word.startsWith('compile:')
      )
    }

    // 1. Direct subcommands/scripts
    if (isVerifierWord(firstToken)) {
      return true
    }

    // 2. Package manager execution (without 'run')
    if (
      (firstToken === 'bun' ||
        firstToken === 'npm' ||
        firstToken === 'pnpm' ||
        firstToken === 'yarn' ||
        firstToken === 'deno') &&
      finalTokens.length >= 2
    ) {
      const sub = finalTokens[1]
      if (sub && isVerifierWord(sub)) {
        return true
      }
    }

    // 3. Known test runners
    if (
      firstToken === 'pytest' ||
      firstToken === 'jest' ||
      firstToken === 'vitest' ||
      firstToken === 'tsc'
    ) {
      return true
    }

    // 4. Cargo / Go test runner
    if ((firstToken === 'cargo' || firstToken === 'go') && finalTokens.length >= 2) {
      if (finalTokens[1] === 'test') {
        return true
      }
    }

    // 5. Python test execution
    if ((firstToken === 'python' || firstToken === 'python3') && finalTokens.length >= 2) {
      if (finalTokens.slice(1).some((t) => t === 'pytest' || t === 'unittest')) {
        return true
      }
    }
  }

  return false
}

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
  ctx: QueryLoopContext,
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
      if (name === 'Bash') {
        const command = (validatedInput as { command: string }).command

        // 2. Coalesce/determine if it is a verification run
        const isVerificationRun = ctx.verificationCommand
          ? isVerificationCommand(command, ctx.verificationCommand)
          : false

        if (!ctx.verificationCommand && isVerificationCommand(command)) {
          ctx.verificationCommand = command
        }

        let toolResult: ToolResult
        let verifyResult: VerifyResult & { isVerificationRun: boolean }

        if (isVerificationRun && !ctx.sandbox?.enabled) {
          try {
            const vr = await verify(command, ctx.repoRoot, ctx.abortSignal, true)
            verifyResult = {
              ...vr,
              isVerificationRun,
            }
            toolResult = {
              ok: true,
              value: JSON.stringify({
                stdout: vr.stdout,
                stderr: vr.stderr,
                code: vr.exit_code,
              }),
            }
          } catch (err) {
            return {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }
          }
        } else {
          // 1. Run the standard tool call, which performs the safety checks and spawns the command
          toolResult = await tool.call(validatedInput, ctx)
          if (!toolResult.ok) {
            return toolResult
          }

          // Parse exit code, stdout, and stderr from the JSON tool value
          const parsed = JSON.parse(toolResult.value as string)
          const exitCode = parsed.code
          const stdoutText = parsed.stdout
          const stderrText = parsed.stderr

          // 3. Process fingerprints if command failed
          const fingerprints: Fingerprint[] = []
          if (exitCode !== 0) {
            const errorOutput = (stderrText || stdoutText || '').trim()
            if (errorOutput) {
              const scrubbed = scrub(errorOutput, ctx.repoRoot)
              const model = getResolvedModel()
              const fp = await defaultCachedExtractor.getOrCreate(scrubbed, command, { model })
              fingerprints.push(fp)
            }
          }

          // 4. Construct the verification result structure
          verifyResult = {
            verdict: exitCode === 0 ? ('PASS' as const) : ('FAIL' as const),
            fingerprints,
            command,
            exit_code: exitCode,
            stale: false,
            stdout: stdoutText,
            stderr: stderrText,
            isVerificationRun,
          }
          if (isVerificationRun) {
            appendJournal({
              kind: 'verify',
              verdict: verifyResult.verdict,
              fingerprints: verifyResult.fingerprints,
              command: verifyResult.command,
              exit_code: verifyResult.exit_code,
              stale: verifyResult.stale,
            })
          }
        }

        ctx._lastVerifyResult = verifyResult

        return toolResult
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

  let fingerprints: Fingerprint[] | undefined = undefined
  let exitCode: number | undefined = undefined
  if (name === 'Bash') {
    const vr = ctx._lastVerifyResult
    if (vr) {
      exitCode = vr.exit_code
      fingerprints = vr.fingerprints.length > 0 ? vr.fingerprints : undefined
      if (vr.isVerificationRun) {
        ctx._lastVerifyResultForQuery = vr
      }
      ctx._lastVerifyResult = undefined
      if (fingerprints) {
        ctx._lastFingerprints = fingerprints
      }
    }
  }

  let targetPath: string | undefined = undefined
  if (rawInput && typeof rawInput === 'object' && 'path' in rawInput) {
    const p = (rawInput as { path?: unknown }).path
    if (typeof p === 'string') {
      targetPath = p
    }
  }

  let targetCmd: string | undefined = undefined
  if (rawInput && typeof rawInput === 'object' && 'command' in rawInput) {
    const c = (rawInput as { command?: unknown }).command
    if (typeof c === 'string') {
      targetCmd = c
    }
  }

  appendJournal({
    kind: 'tool',
    tool: name,
    input_digest: inputDigest,
    outcome: result.ok ? 'success' : 'failure',
    error_class: errorClass,
    duration_ms: durationMs,
    path: targetPath,
    cmd: targetCmd,
    sandboxed: name === 'Bash' && ctx.sandbox?.enabled === true ? true : undefined,
    exit_code: exitCode,
    fingerprints,
  })

  return result
}
