import { readFile as fsReadFile, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import z from 'zod'
import type { Tool, ToolContext, ToolResult } from './Tool'

// Zod schema defining the input argument shape
const ReadInputSchema = z.object({
  path: z.string().min(1, 'path is required'),
})

type ReadInput = z.infer<typeof ReadInputSchema>

class ReadTool implements Tool<ReadInput, string> {
  name = 'Read'
  description = 'Read the contents of a file from the filesystem with line numbers.'
  inputSchema = ReadInputSchema

  isConcurrencySafe(): boolean {
    return true // Reading files has no side effects and is concurrency safe
  }

  isReadOnly(): boolean {
    return true // Read is a read-only tool and skips permission prompts
  }

  async call(input: ReadInput, ctx: ToolContext): Promise<ToolResult<string>> {
    // 1. Resolve absolute path relative to repoRoot
    const targetPath = resolve(ctx.repoRoot, input.path)

    // 2. Traversal Guard: Ensure path starts with repoRoot + separator
    const startsWithRoot = targetPath.startsWith(ctx.repoRoot + sep) || targetPath === ctx.repoRoot
    if (!startsWithRoot) {
      return { ok: false, error: 'path_outside_repo: Resolved path escapes the repository root.' }
    }

    // 3. Symlink Guard: Ensure the real absolute path does not resolve outside the repo root
    let realTargetPath: string
    try {
      realTargetPath = await realpath(targetPath)
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        return { ok: false, error: `file_not_found: File "${input.path}" does not exist.` }
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

    // 4. Read the target file
    try {
      const content = await fsReadFile(realTargetPath, 'utf-8')

      // 5. Line Numbering: Prefix every line with a 1-indexed line number and tab
      const lines = content.split(/\r?\n/)
      const numberedContent = lines.map((line, index) => `${index + 1}\t${line}`).join('\n')
      return { ok: true, value: numberedContent }
    } catch (err) {
      return { ok: false, error: `read_error: ${(err as Error).message}` }
    }
  }
}

export const readTool = new ReadTool()
