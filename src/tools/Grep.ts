// biome-ignore lint/suspicious/noExplicitAny: global environment type bypass
declare const Bun: any
import { spawnSync } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import z from 'zod'
import type { Tool, ToolContext, ToolResult } from './Tool'

// Input validation schema using Zod
const GrepInputSchema = z.object({
  pattern: z.string().min(1, 'pattern is required'),
  path: z.string().optional(),
})

type GrepInput = z.infer<typeof GrepInputSchema>

let resolvedRgPath = rgPath

/**
 * Checks if ripgrep is available via the vscode-ripgrep path.
 * If not, falls back to using the system 'rg' command.
 */
function checkRgAvailability(): void {
  try {
    const result = spawnSync(resolvedRgPath, ['--version'], { encoding: 'utf-8' })
    if (result.status === 0 && result.stdout.startsWith('ripgrep ')) {
      return
    }
  } catch {}

  // Fallback to system rg
  resolvedRgPath = 'rg'
}

checkRgAvailability()

/**
 * GrepTool searches for regular expression patterns in file contents
 * relative to the repository root, enforcing traversal and symlink checks.
 */
class GrepTool implements Tool<GrepInput, string> {
  name = 'Grep'
  description =
    'Search for regular expression patterns in file contents relative to the repository root.'
  inputSchema = GrepInputSchema

  /**
   * Indicates that the Grep tool has no side effects and is concurrency safe.
   *
   * @returns True, since Grep operations are concurrency safe.
   */
  isConcurrencySafe(): boolean {
    return true
  }

  /**
   * Indicates that the Grep tool only performs read operations and is read-only.
   *
   * @returns True, since Grep is a read-only search tool.
   */
  isReadOnly(): boolean {
    return true
  }

  /**
   * Executes a regex search in workspace files using ripgrep.
   * Enforces repository boundary limits, caps matches per file at 50,
   * and limits total output characters to 30,000.
   *
   * @param input Contains the regex pattern and optional subdirectory path.
   * @param ctx The tool execution context containing the repository root.
   * @returns A promise resolving to the structured tool result containing the search matches.
   */
  async call(input: GrepInput, ctx: ToolContext): Promise<ToolResult<string>> {
    // 1. Determine target path, resolving relative to repoRoot
    const targetPath = input.path ? resolve(ctx.repoRoot, input.path) : ctx.repoRoot

    // 2. Traversal Guard: Ensure targetPath is inside the repository root
    const startsWithRoot = targetPath.startsWith(ctx.repoRoot + sep) || targetPath === ctx.repoRoot
    if (!startsWithRoot) {
      return {
        ok: false,
        error: 'path_outside_repo: The specified path escapes the repository root.',
      }
    }

    // 3. Symlink Guard: Ensure realTargetPath does not resolve outside the repo root if it exists
    let realTargetPath = targetPath
    try {
      // Check if target path exists and resolve real path
      await stat(targetPath)
      realTargetPath = await realpath(targetPath)
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        return {
          ok: false,
          error: `path_not_found: The specified path "${input.path || ''}" does not exist.`,
        }
      }
      return { ok: false, error: `path_error: ${(err as Error).message}` }
    }

    const realStartsWithRoot =
      realTargetPath.startsWith(ctx.repoRoot + sep) || realTargetPath === ctx.repoRoot
    if (!realStartsWithRoot) {
      return {
        ok: false,
        error: 'path_outside_repo: Symlink target resolves outside the repository root.',
      }
    }

    // 4. Set up ripgrep command arguments
    const args = [
      '--json',
      '--hidden',
      '--max-columns',
      '500',
      '--glob',
      '!node_modules',
      '--glob',
      '!.git',
      '-e',
      input.pattern,
      realTargetPath,
    ]

    // biome-ignore lint/suspicious/noExplicitAny: Bun process handle
    let proc: any
    // biome-ignore lint/suspicious/noExplicitAny: timeout handle type
    let timeoutId: any
    let timedOut = false
    let aborted = false

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId)
      if (ctx.abortSignal) {
        ctx.abortSignal.removeEventListener('abort', handleAbort)
      }
    }

    const handleAbort = () => {
      aborted = true
      cleanup()
      if (proc) {
        try {
          proc.kill()
        } catch {}
      }
    }

    try {
      if (ctx.abortSignal) {
        if (ctx.abortSignal.aborted) {
          return { ok: false, error: 'aborted: Grep operation cancelled prior to execution.' }
        }
        ctx.abortSignal.addEventListener('abort', handleAbort)
      }

      // 30s timeout watchdog
      timeoutId = setTimeout(() => {
        timedOut = true
        cleanup()
        if (proc) {
          try {
            proc.kill()
          } catch {}
        }
      }, 30000)

      proc = Bun.spawn({
        cmd: [resolvedRgPath, ...args],
        cwd: ctx.repoRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const [stdoutText, stderrText, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      cleanup()

      if (timedOut) {
        return { ok: false, error: 'timeout: Grep operation exceeded 30s timeout.' }
      }
      if (aborted) {
        return { ok: false, error: 'aborted: Grep operation cancelled.' }
      }

      // Exit code 2 is returned on critical error (like bad flags, although we use hardcoded safe ones)
      if (exitCode === 2) {
        return { ok: false, error: `grep_error: ${stderrText.trim()}` }
      }

      // Process json lines output
      const lines = stdoutText.split('\n')
      const resultsByFile = new Map<string, Array<{ lineNumber: number; lineContent: string }>>()

      for (const line of lines) {
        if (!line) continue
        try {
          const obj = JSON.parse(line)
          if (obj.type === 'match') {
            const filePath = obj.data.path.text
            const relPath = relative(ctx.repoRoot, filePath)
            const lineNumber = obj.data.line_number
            const lineContent = obj.data.lines.text.replace(/\r?\n$/, '')

            if (!resultsByFile.has(relPath)) {
              resultsByFile.set(relPath, [])
            }
            const fileMatches = resultsByFile.get(relPath)
            if (fileMatches && fileMatches.length < 50) {
              fileMatches.push({ lineNumber, lineContent })
            }
          }
        } catch {
          // Skip invalid JSON lines
        }
      }

      let output = ''
      for (const [file, matches] of resultsByFile.entries()) {
        output += `${file}:\n`
        for (const match of matches) {
          output += `  ${match.lineNumber}: ${match.lineContent}\n`
        }
        output += '\n'
      }

      const trimmedOutput = output.trim()
      if (!trimmedOutput) {
        return { ok: true, value: 'No matches found.' }
      }

      let finalValue = trimmedOutput
      if (finalValue.length > 30000) {
        finalValue = `${finalValue.slice(0, 29900)}\n... [Output truncated to stay under 30000 character limit]`
      }

      return { ok: true, value: finalValue }
    } catch (err) {
      cleanup()
      return { ok: false, error: `grep_error: ${(err as Error).message}` }
    }
  }
}

export const grepTool = new GrepTool()
