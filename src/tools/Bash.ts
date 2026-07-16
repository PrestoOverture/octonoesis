// biome-ignore lint/suspicious/noExplicitAny: global environment type bypass
declare const Bun: any
import { z } from 'zod'
import { resolveSandboxConfig } from '../sandbox/manager'
import type { ResolvedSandboxConfig } from '../sandbox/types'
import { wrapWithSandbox } from '../sandbox/wrapper'
import { startLocalShellTask } from '../tasks/localShell'
import { shellChildEnv } from '../utils/childEnv'
import type { Tool, ToolContext, ToolResult } from './Tool'
export const activeSubprocesses = new Set<unknown>()

// Input validation schema using Zod
const BashInputSchema = z.object({
  command: z.string().min(1, 'command is required'),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      'Run a long command without blocking the conversation. The task returns immediately and a completion notification arrives on a later turn.',
    ),
})

type BashInput = z.infer<typeof BashInputSchema>

const blockedPatterns: [RegExp, string][] = [
  [/\brm\s+-\w*r\w*f\w*/, 'rm -rf'],
  [/\brm\s+-\w*f\w*r\w*/, 'rm -rf'],
  [/\brm\s.*\s-\w*r\b.*\s-\w*f\b/, 'rm -rf'],
  [/\brm\s.*\s-\w*f\b.*\s-\w*r\b/, 'rm -rf'],
  [/\bcurl\b/, 'curl'],
  [/\bwget\b/, 'wget'],
  [/\bsudo\b/, 'sudo'],
]

export function isBlockedCommand(command: string): string | null {
  const normalized = command.replace(/\s+/g, ' ').trim()
  for (const [pattern, label] of blockedPatterns) {
    if (pattern.test(normalized)) return label
  }
  return null
}

function resolveToolSandbox(ctx: ToolContext): ResolvedSandboxConfig | undefined {
  if (!ctx.sandbox?.enabled) return undefined

  if (
    'repoRoot' in ctx.sandbox &&
    'protectedWrite' in ctx.sandbox &&
    ctx.sandbox.filesystem?.allowWrite &&
    ctx.sandbox.filesystem.denyRead &&
    ctx.sandbox.network?.allowedDomains
  ) {
    return ctx.sandbox as ResolvedSandboxConfig
  }

  return resolveSandboxConfig({ repoRoot: ctx.repoRoot, config: ctx.sandbox })
}

class BashTool implements Tool<BashInput, string> {
  name = 'Bash'
  description =
    'Execute a shell command in a non-interactive bash session. Long commands can run in the background and notify you when they finish.'
  inputSchema = BashInputSchema

  isConcurrencySafe(): boolean {
    return false // Shell executions are dangerous to run in parallel as they can mutate state
  }

  isReadOnly(): boolean {
    return false // Shell executions can mutate the filesystem and are not read-only
  }

  async call(input: BashInput, ctx: ToolContext): Promise<ToolResult<string>> {
    const blocked = isBlockedCommand(input.command)
    if (blocked) {
      return {
        ok: false,
        error: `blocked_command: Command contains forbidden operation "${blocked}".`,
      }
    }

    if (input.run_in_background) {
      try {
        const record = await startLocalShellTask({
          ctx,
          command: input.command,
          sandbox: resolveToolSandbox(ctx),
        })
        return {
          ok: true,
          value: JSON.stringify({
            task_id: record.task.id,
            status: 'running',
            output_log: `.octonoesis/tasks/${record.task.id}.log`,
          }),
        }
      } catch (error) {
        return { ok: false, error: `execution_error: ${(error as Error).message}` }
      }
    }

    // biome-ignore lint/suspicious/noExplicitAny: Bun process handle
    let proc: any
    // biome-ignore lint/suspicious/noExplicitAny: timeout handle type
    let timeoutId: any
    let timedOut = false
    let aborted = false

    // Clean up timers and listeners
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId)
      if (ctx.abortSignal) {
        ctx.abortSignal.removeEventListener('abort', handleAbort)
      }
      if (proc) {
        activeSubprocesses.delete(proc)
      }
    }

    const handleAbort = () => {
      aborted = true
      cleanup()
      signalProcessGroup(proc)
    }

    try {
      const sandbox = resolveToolSandbox(ctx)

      // 2. Register abort listener if signal is present
      if (ctx.abortSignal) {
        if (ctx.abortSignal.aborted) {
          return { ok: false, error: 'aborted: Command cancelled prior to execution.' }
        }
        ctx.abortSignal.addEventListener('abort', handleAbort)
      }

      // 3. Set a 120-second hard execution timeout
      timeoutId = setTimeout(() => {
        timedOut = true
        cleanup()
        signalProcessGroup(proc)
      }, 120_000)

      // 4. Spawn process using Bun.spawn
      proc = Bun.spawn({
        cmd: sandbox ? wrapWithSandbox(input.command, sandbox) : ['bash', '-c', input.command],
        cwd: ctx.repoRoot,
        env: shellChildEnv(),
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true, // Run in a separate process
      })
      activeSubprocesses.add(proc)

      // 5. Stream and wait for stdout and stderr to complete
      const [stdoutText, stderrText, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      cleanup()

      // 6. Handle timeout or cancellation exit states
      if (timedOut) {
        return {
          ok: false,
          error: 'timeout: Command execution exceeded the 120-second timeout limit and was killed.',
        }
      }
      if (aborted) {
        return { ok: false, error: 'aborted: Command execution aborted by user.' }
      }

      // 7. Format structured output back to the model as a JSON string
      let returnedStderr = stderrText
      if (
        sandbox &&
        exitCode !== 0 &&
        /operation not permitted|deny/i.test(stderrText) &&
        !stderrText.includes('[octonoesis-sandbox]')
      ) {
        const separator = stderrText.length > 0 && !stderrText.endsWith('\n') ? '\n' : ''
        returnedStderr = `${stderrText}${separator}[octonoesis-sandbox] This failure may be a sandbox denial rather than a code bug.\n`
      }

      const resultObj = {
        code: exitCode,
        stdout: stdoutText,
        stderr: returnedStderr,
      }

      return { ok: true, value: JSON.stringify(resultObj) }
    } catch (err) {
      cleanup()
      return { ok: false, error: `execution_error: ${(err as Error).message}` }
    }
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Bun process handle
function signalProcessGroup(proc: any): void {
  if (!proc) return
  try {
    process.kill(-proc.pid, 'SIGTERM')
  } catch {
    try {
      proc.kill('SIGTERM')
    } catch {}
  }
}

export const bashTool = new BashTool()
