import { realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import z from 'zod'
import type { Tool, ToolContext, ToolResult } from './Tool'

// Zod schema defining the input argument shape
const WriteInputSchema = z.object({
  path: z.string().min(1, 'path is required'),
  content: z.string(),
})

type WriteInput = z.infer<typeof WriteInputSchema>

class WriteTool implements Tool<WriteInput, string> {
  name = 'Write'
  description = 'Create a new file with the specified content. Fails if the file already exists.'
  inputSchema = WriteInputSchema

  isConcurrencySafe(): boolean {
    return false // Writing files can have side effects on the filesystem
  }

  isReadOnly(): boolean {
    return false // Write is a modifying tool and requires permission prompts
  }

  async call(input: WriteInput, ctx: ToolContext): Promise<ToolResult<string>> {
    // 1. Resolve absolute path relative to repoRoot
    const targetPath = resolve(ctx.repoRoot, input.path)

    // 2. Traversal Guard: Ensure path starts with repoRoot + separator
    const startsWithRoot = targetPath.startsWith(ctx.repoRoot + sep) || targetPath === ctx.repoRoot
    if (!startsWithRoot) {
      return { ok: false, error: 'path_outside_repo: Resolved path escapes the repository root.' }
    }

    // 3. Existence Check: Fails if the file already exists
    try {
      await stat(targetPath)
      return { ok: false, error: `file_exists: File already exists at "${input.path}".` }
    } catch (err) {
      // Expect error if the file doesn't exist
      if ((err as { code?: string }).code !== 'ENOENT') {
        return { ok: false, error: `stat_error: ${(err as Error).message}` }
      }
    }

    // 4. Validate Parent Directory: Must exist and must stay inside repoRoot
    const parentDir = dirname(targetPath)
    let realParentDir: string
    try {
      realParentDir = await realpath(parentDir)
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        return {
          ok: false,
          error: `parent_dir_not_found: The parent directory of "${input.path}" does not exist.`,
        }
      }
      return { ok: false, error: `parent_dir_error: ${(err as Error).message}` }
    }

    const parentStartsWithRoot =
      realParentDir.startsWith(ctx.repoRoot + sep) || realParentDir === ctx.repoRoot
    if (!parentStartsWithRoot) {
      return {
        ok: false,
        error: 'path_outside_repo: Parent directory resolves outside the repository root.',
      }
    }

    // 5. Write the file content to disk
    try {
      await writeFile(targetPath, input.content, 'utf-8')
      return { ok: true, value: `File successfully created at "${input.path}".` }
    } catch (err) {
      return { ok: false, error: `write_error: ${(err as Error).message}` }
    }
  }
}

export const writeTool = new WriteTool()
