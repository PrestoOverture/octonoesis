import { readFile as fsReadFile } from 'node:fs/promises'
import z from 'zod'
import { recordFileRead } from '../state/fileState'
import { assertInsideRepo } from '../utils/path'
import type { Tool, ToolContext, ToolResult } from './Tool'

// Zod schema defining the input argument shape
const ReadInputSchema = z.object({
  path: z.string().min(1, 'path is required'),
  offset: z.number().int().positive().optional().describe('1-based starting line (default: 1).'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum lines to return (default: 2000).'),
})

type ReadInput = z.infer<typeof ReadInputSchema>

class ReadTool implements Tool<ReadInput, string> {
  name = 'Read'
  description = 'Read the contents of a file from the filesystem with line numbers.'
  inputSchema = ReadInputSchema

  /**
   * Indicates whether Read operations are concurrency safe.
   *
   * @returns True, as reading files does not mutate filesystem state.
   */
  isConcurrencySafe(): boolean {
    return true // Reading files has no side effects and is concurrency safe
  }

  /**
   * Indicates whether Read is a read-only tool.
   *
   * @returns True, allowing execution without confirmation prompts.
   */
  isReadOnly(): boolean {
    return true // Read is a read-only tool and skips permission prompts
  }

  /**
   * Reads a file from the repository, formats its content with 1-indexed line numbers and tabs,
   * and updates the file read hash cache for edit verification.
   *
   * @param input - Object containing the file path to read.
   * @param ctx - Tool execution context containing repository root and file cache state.
   * @returns ToolResult with line-numbered file content or an error.
   */
  async call(input: ReadInput, ctx: ToolContext): Promise<ToolResult<string>> {
    const guard = await assertInsideRepo(input.path, ctx.repoRoot)
    if (!guard.ok) return guard

    const realTargetPath = guard.realPath
    try {
      const bytes = await fsReadFile(realTargetPath)
      if (bytes.subarray(0, 8192).includes(0)) {
        return { ok: false, error: 'binary_file: File contains a NUL byte in the first 8KB.' }
      }
      const content = bytes.toString('utf-8')

      // Record the file state cache in the context
      recordFileRead(ctx, realTargetPath, content)

      const lines = content.split(/\r?\n/)
      const start = Math.min((input.offset ?? 1) - 1, lines.length)
      const end = Math.min(start + (input.limit ?? 2000), lines.length)
      let cut = start > 0 || end < lines.length
      let output = ''
      let last = start
      for (let index = start; index < end; index++) {
        const line = lines[index] ?? ''
        if (line.length > 2000) cut = true
        const row = `${index + 1}\t${line.slice(0, 2000)}`
        const separator = output ? '\n' : ''
        // Reserve footer space when this row would leave any content undisplayed.
        const footer = `\n[lines ${start + 1}-${index + 1} of ${lines.length}; use offset to read more]`
        const needsFooter =
          cut || index + 1 < lines.length || output.length + separator.length + row.length > 100_000
        const budget = 100_000 - (needsFooter ? footer.length : 0)
        const available = budget - output.length - separator.length
        if (available < row.length) {
          if (available > `${index + 1}\t`.length) {
            output += separator + row.slice(0, available)
            last = index + 1
          }
          cut = true
          break
        }
        output += separator + row
        last = index + 1
      }
      if (cut) {
        output += `${output ? '\n' : ''}[lines ${start + 1}-${last} of ${lines.length}; use offset to read more]`
      }
      return { ok: true, value: output }
    } catch (err) {
      return { ok: false, error: `read_error: ${(err as Error).message}` }
    }
  }
}

export const readTool = new ReadTool()
