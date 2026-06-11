import { release as osRelease, type as osType } from 'node:os'
import type { ToolContext } from '../query'

// biome-ignore lint/suspicious/noExplicitAny: global environment type bypass
declare const Bun: any

/**
 * Builds the dynamic suffix for the system prompt.
 * Contains: OS, Shell, CWD, current time, Node/Bun versions, Git Status, Model Name, and Token Usage.
 *
 * @param ctx The current tool execution context.
 * @param modelName The active LLM model name.
 * @param usage The cumulative input and output token count.
 * @return A promise resolving to the formatted dynamic prompt suffix string.
 */
export async function buildDynamicSuffix(
  ctx: ToolContext,
  modelName: string,
  usage: { input_tokens: number; output_tokens: number },
): Promise<string> {
  const osInfo = `${osType()} ${osRelease()}`
  const shellInfo = process.env.SHELL || 'unknown'
  const cwd = process.cwd()
  const currentTime = new Date().toISOString()
  const bunVersion = process.versions.bun || 'N/A'
  const nodeVersion = process.versions.node || 'N/A'

  // Fetch Git Status using Bun.spawn
  let gitStatus = 'no git'
  try {
    const proc = Bun.spawn(['git', 'status', '--porcelain'], {
      cwd: ctx.repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    if (exitCode === 0) {
      gitStatus = stdout.trim() || 'clean'
    }
  } catch (err) {
    // Failure degrades to 'no git'
  }

  return `## Runtime Environment
- **Operating System**: ${osInfo}
- **Shell**: ${shellInfo}
- **Current Directory**: ${cwd}
- **Current Time**: ${currentTime}
- **Bun Version**: ${bunVersion}
- **Node Version**: ${nodeVersion}
- **Git Status**:
${
  gitStatus === 'clean' || gitStatus === 'no git'
    ? gitStatus
    : gitStatus
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')
}
- **Active Model**: ${modelName}
- **Cumulative Tokens**: Input: ${usage.input_tokens}, Output: ${usage.output_tokens}`
}
