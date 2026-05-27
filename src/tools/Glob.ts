import { resolve, sep } from 'node:path'
import glob from 'fast-glob'
import z from 'zod'
import type { Tool, ToolContext, ToolResult } from './Tool'

// Input validation schema using Zod
const GlobInputSchema = z.object({
  pattern: z.string().min(1, 'pattern is required'),
  cwd: z.string().optional(),
  limit: z.number().int().positive().optional(),
})

type GlobInput = z.infer<typeof GlobInputSchema>

class GlobTool implements Tool<GlobInput, string[]> {
  name = 'Glob'
  description =
    'Find files matching a glob pattern relative to the repository root or a given subdirectory.'
  inputSchema = GlobInputSchema

  isConcurrencySafe(): boolean {
    return true // Glob has no side effects and is concurrency safe
  }

  isReadOnly(): boolean {
    return true // Glob only searches/lists and is read-only
  }

  async call(input: GlobInput, ctx: ToolContext): Promise<ToolResult<string[]>> {
    // 1. Determine target directory, resolving relative to repoRoot
    const absoluteCwd = input.cwd ? resolve(ctx.repoRoot, input.cwd) : ctx.repoRoot

    // 2. Traversal Guard: Ensure absoluteCwd is inside the repository root
    const startsWithRoot =
      absoluteCwd.startsWith(ctx.repoRoot + sep) || absoluteCwd === ctx.repoRoot
    if (!startsWithRoot) {
      return {
        ok: false,
        error: 'path_outside_repo: The specified cwd escapes the repository root.',
      }
    }

    const matchLimit = input.limit ?? 5000

    try {
      // 3. Perform glob search
      const files = await glob(input.pattern, {
        cwd: absoluteCwd,
        ignore: ['**/node_modules/**', '**/.git/**'],
        onlyFiles: true,
        dot: true, // Include dotfiles like .gitignore
      })

      // 4. Truncate files according to limit
      const truncatedFiles = files.slice(0, matchLimit)
      return { ok: true, value: truncatedFiles }
    } catch (err) {
      return { ok: false, error: `glob_error: ${(err as Error).message}` }
    }
  }
}

export const globTool = new GlobTool()
