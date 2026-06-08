import { readFile, realpath, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { diffLines } from 'diff'
import z from 'zod'
import { checkFileState, recordFileRead } from '../state/fileState'
import type { Tool, ToolContext, ToolResult } from './Tool'

// Zod schema defining the input argument shape
const EditInputSchema = z.object({
  path: z.string().min(1, 'path is required'),
  old_string: z.string(),
  new_string: z.string(),
})

type EditInput = z.infer<typeof EditInputSchema>

class EditTool implements Tool<EditInput, string> {
  name = 'Edit'
  description = 'Replace a unique occurrence of old_string with new_string in a file.'
  inputSchema = EditInputSchema

  isConcurrencySafe(): boolean {
    return false // Editing files has side effects on the filesystem
  }

  isReadOnly(): boolean {
    return false // Edit is a modifying tool and requires permission prompts
  }

  async call(input: EditInput, ctx: ToolContext): Promise<ToolResult<string>> {
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

    // 4. Cache Guard: Must read file first and check if changed since read
    const stateStatus = await checkFileState(ctx, realTargetPath)
    if (stateStatus === 'must_read_first') {
      return { ok: false, error: 'must_read_first: Edit attempted before a cached Read.' }
    }
    if (stateStatus === 'file_changed_since_read') {
      return {
        ok: false,
        error:
          'file_changed_since_read: File was modified since it was last read. Please re-read the file.',
      }
    }

    // 5. Read target content and find matches
    let content: string
    try {
      content = await readFile(realTargetPath, 'utf-8')
    } catch (err) {
      return { ok: false, error: `read_error: ${(err as Error).message}` }
    }

    const parts = content.split(input.old_string)
    const occurrences = parts.length - 1

    if (occurrences === 0) {
      return {
        ok: false,
        error: 'edit_error: The specified old_string was not found in the file.',
      }
    }
    if (occurrences > 1) {
      return {
        ok: false,
        error:
          'edit_error: Multiple occurrences of old_string were found. Edit must target a unique substring.',
      }
    }

    // 6. Diff constraint: diff <= 200 lines
    const changes = diffLines(input.old_string, input.new_string)
    let lineChanges = 0
    for (const change of changes) {
      if (change.added || change.removed) {
        lineChanges += change.count ?? change.value.split(/\r?\n/).length
      }
    }

    if (lineChanges > 200) {
      return {
        ok: false,
        error: `diff_too_large: The proposed edit changes ${lineChanges} lines, which exceeds the maximum limit of 200 lines.`,
      }
    }

    // 7. Perform replacement and write file
    const updatedContent = content.replace(input.old_string, input.new_string)
    try {
      await writeFile(realTargetPath, updatedContent, 'utf-8')

      // Update cached hash to enable consecutive edits without manual re-reading
      recordFileRead(ctx, realTargetPath, updatedContent)

      return { ok: true, value: `File successfully edited at "${input.path}".` }
    } catch (err) {
      return { ok: false, error: `write_error: ${(err as Error).message}` }
    }
  }
}

export const editTool = new EditTool()
