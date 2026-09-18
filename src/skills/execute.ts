import { appendJournal } from '../memory/journal'
import { forkAgent } from '../providers/fork'
import type { Usage } from '../providers/types'
import type { ToolContext, ToolResult } from '../tools/Tool'
import { getTool } from '../tools/registry'
import { dbg } from '../utils/debug'
import { zodToJsonSchema } from '../utils/schema'
import { loadSkills } from './loader'
import type { SkillDefinition } from './types'

export const READ_ONLY_FORK_SKILL_TOOLS = ['Read', 'Grep', 'Glob'] as const

/** Options passed when invoking an inline or forked skill definition. */
export interface ExecuteSkillOptions {
  args?: string
  ctx: ToolContext
  systemPrompt: string
  onForkUsage?: (usage: Usage) => void
}

/**
 * Formats inline skill prompt content, appending any user-supplied arguments to the body.
 *
 * @param skill - Skill definition containing Markdown content.
 * @param args - Optional invocation arguments.
 * @returns Formatted content string.
 */
function inlineContent(skill: SkillDefinition, args?: string): string {
  return args === undefined || args.length === 0
    ? skill.content
    : `${skill.content}\n\nArguments: ${args}`
}

/**
 * Executes a skill definition either inline or within a sandboxed sub-agent fork process.
 * Records skill execution duration and context to the memory journal.
 *
 * @param skill - Skill definition to execute.
 * @param options - Execution options including arguments, context, system prompt, and usage callback.
 * @returns ToolResult containing execution output string or error message.
 */
export async function executeSkill(
  skill: SkillDefinition,
  options: ExecuteSkillOptions,
): Promise<ToolResult<string>> {
  const started = performance.now()
  try {
    if (skill.context === 'inline') {
      return { ok: true, value: inlineContent(skill, options.args) }
    }

    const requested = skill.allowedTools ?? []
    const permitted = new Set(READ_ONLY_FORK_SKILL_TOOLS)
    const allowedNames = requested.filter((name) => permitted.has(name as never))
    const dropped = requested.filter((name) => !permitted.has(name as never))
    if (dropped.length > 0) {
      dbg('skills', 'Dropped non-read-only fork skill tools', { skill: skill.name, dropped })
    }
    const tools = allowedNames.flatMap((name) => {
      const tool = getTool(name)
      if (!tool || !tool.isReadOnly({})) return []
      return [
        {
          name: tool.name,
          description: tool.description,
          inputSchema: zodToJsonSchema(tool.inputSchema) as Record<string, unknown>,
        },
      ]
    })
    const result = await forkAgent({
      forkPurpose: 'skill',
      systemPrompt: options.systemPrompt,
      messages: [{ role: 'user', content: inlineContent(skill, options.args) }],
      tools,
      ...(skill.model ? { model: skill.model } : {}),
      maxTurns: 8,
      timeoutMs: 120_000,
      signal: options.ctx.abortSignal,
      repoRoot: options.ctx.repoRoot,
    })
    options.onForkUsage?.(result.usage)
    if (result.exitReason === 'fatal_error' || result.exitReason === 'user_cancel') {
      return { ok: false, error: result.error ?? `Skill fork exited: ${result.exitReason}` }
    }
    return { ok: true, value: result.text }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    appendJournal({
      kind: 'skill',
      skill: skill.name,
      context: skill.context,
      duration_ms: Math.max(0, Math.round(performance.now() - started)),
    })
  }
}

/**
 * Rewrites a leading slash command input (e.g. `/commit`) into a natural language instruction
 * invoking the matching skill via the Skill tool if the skill is known.
 *
 * @param input - Raw user input string.
 * @param repoRoot - Repository root directory used to load available skills.
 * @returns Rewritten prompt string if a matching skill is found; otherwise original input.
 */
export async function rewriteSkillSlashCommand(input: string, repoRoot: string): Promise<string> {
  const match = input.match(/^\/([a-z0-9][a-z0-9-]*)(\s+.*)?$/)
  if (!match) return input
  const skills = await loadSkills(repoRoot)
  if (!skills.some((skill) => skill.name === match[1])) return input
  const args = match[2]?.trim()
  return args
    ? `Invoke the skill "${match[1]}" via the Skill tool with args: ${args}`
    : `Invoke the skill "${match[1]}" via the Skill tool.`
}
