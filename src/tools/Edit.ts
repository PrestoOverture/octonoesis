import { readFile } from 'node:fs/promises'
import z from 'zod'
import { writeWithCheckpoint } from '../state/fileHistory'
import { checkFileState, recordFileRead } from '../state/fileState'
import { assertInsideRepo } from '../utils/path'
import type { Tool, ToolContext, ToolResult } from './Tool'

// Zod schema defining the input argument shape
const EditInputSchema = z.object({
  path: z.string().min(1, 'path is required'),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
})

type EditInput = z.infer<typeof EditInputSchema>

class EditTool implements Tool<EditInput, string> {
  name = 'Edit'
  description =
    'Replace old_string with new_string in a file Read this session and unchanged since. By default old_string must match uniquely; set replace_all to true to replace every occurrence.'
  inputSchema = EditInputSchema

  /**
   * Indicates whether Edit operations are concurrency safe.
   *
   * @returns False, as file modifications mutate filesystem state.
   */
  isConcurrencySafe(): boolean {
    return false // Editing files has side effects on the filesystem
  }

  /**
   * Indicates whether Edit is a read-only tool.
   *
   * @returns False, as editing files mutates content and requires user permission.
   */
  isReadOnly(): boolean {
    return false // Edit is a modifying tool and requires permission prompts
  }

  /**
   * Replaces one unique occurrence, or all occurrences when replace_all is true.
   * Enforces repository containment and read-before-edit staleness checks.
   * Updates file state cache upon successful write; the permission UI bounds diff previews.
   *
   * @param input - Contains file path, old string to find, and new replacement string.
   * @param ctx - Tool execution context containing repository root and file state cache.
   * @returns ToolResult indicating success message or descriptive error.
   */
  async call(input: EditInput, ctx: ToolContext): Promise<ToolResult<string>> {
    const guard = await assertInsideRepo(input.path, ctx.repoRoot)
    if (!guard.ok) return guard

    const realTargetPath = guard.realPath
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
    if (occurrences > 1 && !input.replace_all) {
      return {
        ok: false,
        error:
          'edit_error: Multiple occurrences of old_string were found. Edit must target a unique substring.',
      }
    }

    // Replace all matches literally, preserving the existing single-replacement behavior.
    const updatedContent = input.replace_all
      ? parts.join(input.new_string)
      : content.replace(input.old_string, input.new_string)
    try {
      await writeWithCheckpoint(ctx, 'Edit', realTargetPath, updatedContent)

      // Update cached hash to enable consecutive edits without manual re-reading
      recordFileRead(ctx, realTargetPath, updatedContent)

      return { ok: true, value: `File successfully edited at "${input.path}".` }
    } catch (err) {
      return { ok: false, error: `write_error: ${(err as Error).message}` }
    }
  }
}

export const editTool = new EditTool()
