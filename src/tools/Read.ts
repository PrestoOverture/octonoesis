import { readFile as fsReadFile } from 'node:fs/promises'
import z from 'zod'
import { recordFileRead } from '../state/fileState'
import { assertInsideRepo } from '../utils/path'
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
    const guard = await assertInsideRepo(input.path, ctx.repoRoot)
    if (!guard.ok) return guard

    const realTargetPath = guard.realPath
    try {
      const content = await fsReadFile(realTargetPath, 'utf-8')

      // Record the file state cache in the context
      recordFileRead(ctx, realTargetPath, content)

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
