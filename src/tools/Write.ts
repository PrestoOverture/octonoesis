import { realpath, stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import z from 'zod'
import { writeWithCheckpoint } from '../state/fileHistory'
import { checkFileState, recordFileRead } from '../state/fileState'
import { assertInsideRepo } from '../utils/path'
import type { Tool, ToolContext, ToolResult } from './Tool'

// Zod schema defining the input argument shape
const WriteInputSchema = z.object({
  path: z.string().min(1, 'path is required'),
  content: z.string(),
})

type WriteInput = z.infer<typeof WriteInputSchema>

class WriteTool implements Tool<WriteInput, string> {
  name = 'Write'
  description =
    'Create a new file, or overwrite an existing file only if it was Read in this session and has not changed since. Overwrites require permission with an old-to-new diff preview.'
  inputSchema = WriteInputSchema

  /**
   * Indicates whether Write operations can run concurrently.
   *
   * @returns False, as writing files mutates filesystem state.
   */
  isConcurrencySafe(): boolean {
    return false // Writing files can have side effects on the filesystem
  }

  /**
   * Indicates whether Write is a read-only tool.
   *
   * @returns False, as file creation alters the filesystem and requires permission prompts.
   */
  isReadOnly(): boolean {
    return false // Write is a modifying tool and requires permission prompts
  }

  /**
   * Creates a file or overwrites an unchanged file Read in this session.
   * Enforces repository containment and validates the parent directory.
   * Refreshes the file state cache after an overwrite.
   *
   * @param input - Contains target file path and file content string.
   * @param ctx - Tool execution context containing repository root.
   * @returns ToolResult indicating success message or descriptive failure error.
   */
  async call(input: WriteInput, ctx: ToolContext): Promise<ToolResult<string>> {
    // 1. Resolve absolute path relative to repoRoot
    const targetPath = resolve(ctx.repoRoot, input.path)

    // 2. Traversal Guard: Ensure path starts with repoRoot + separator
    const startsWithRoot = targetPath.startsWith(ctx.repoRoot + sep) || targetPath === ctx.repoRoot
    if (!startsWithRoot) {
      return { ok: false, error: 'path_outside_repo: Resolved path escapes the repository root.' }
    }

    // Existing files use the same path and file-state guards as Edit.
    let exists = false
    let realTargetPath = targetPath
    try {
      await stat(targetPath)
      exists = true
    } catch (err) {
      // Expect error if the file doesn't exist
      if ((err as { code?: string }).code !== 'ENOENT') {
        return { ok: false, error: `stat_error: ${(err as Error).message}` }
      }
    }

    if (exists) {
      const guard = await assertInsideRepo(input.path, ctx.repoRoot)
      if (!guard.ok) return guard
      realTargetPath = guard.realPath
      const stateStatus = await checkFileState(ctx, realTargetPath)
      if (stateStatus === 'must_read_first') {
        return {
          ok: false,
          error: 'must_read_first: Write overwrite attempted before a cached Read.',
        }
      }
      if (stateStatus === 'file_changed_since_read') {
        return {
          ok: false,
          error:
            'file_changed_since_read: File was modified since it was last read. Please re-read the file.',
        }
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
      await writeWithCheckpoint(ctx, 'Write', realTargetPath, input.content)
      if (exists) recordFileRead(ctx, realTargetPath, input.content)
      return {
        ok: true,
        value: `File successfully ${exists ? 'overwritten' : 'created'} at "${input.path}".`,
      }
    } catch (err) {
      return { ok: false, error: `write_error: ${(err as Error).message}` }
    }
  }
}

export const writeTool = new WriteTool()
