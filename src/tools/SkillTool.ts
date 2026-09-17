import { z } from 'zod'
import type { Usage } from '../providers/types'
import { executeSkill } from '../skills/execute'
import type { SkillDefinition } from '../skills/types'
import type { Tool, ToolContext, ToolResult } from './Tool'

const SkillInputSchema = z.object({
  skill: z.string().min(1),
  args: z.string().optional(),
})

type SkillInput = z.infer<typeof SkillInputSchema>

export interface SkillToolOptions {
  systemPrompt: string
  onForkUsage?: (usage: Usage) => void
}

export class SkillTool implements Tool<SkillInput, string> {
  readonly name = 'Skill'
  readonly description = 'Invoke a loaded project or user skill by name.'
  readonly inputSchema = SkillInputSchema
  private readonly skills: Map<string, SkillDefinition>

  /**
   * Initializes the Skill tool with loaded skill definitions and runtime options.
   *
   * @param skills - Array of available skill definitions.
   * @param options - Options including system prompt and fork usage callback.
   */
  constructor(
    skills: readonly SkillDefinition[],
    private readonly options: SkillToolOptions,
  ) {
    this.skills = new Map(skills.map((skill) => [skill.name, skill]))
  }

  /**
   * Indicates whether Skill execution is concurrency safe.
   *
   * @returns False, as skills may execute sub-agent forks or modify state.
   */
  isConcurrencySafe(): boolean {
    return false
  }

  /**
   * Indicates whether a specific skill invocation is read-only.
   *
   * @param input - Tool input containing target skill name.
   * @returns True if skill context is inline; false if it runs in a fork sub-agent.
   */
  isReadOnly(input: SkillInput): boolean {
    return this.skills.get(input.skill)?.context !== 'fork'
  }

  /**
   * Executes the requested skill inline or in a fork child process.
   *
   * @param input - Contains target skill name and optional argument string.
   * @param ctx - Tool execution context.
   * @returns ToolResult with the skill execution result string or an error if not found.
   */
  async call(input: SkillInput, ctx: ToolContext): Promise<ToolResult<string>> {
    const skill = this.skills.get(input.skill)
    if (!skill) return { ok: false, error: `Unknown skill: ${input.skill}` }
    return executeSkill(skill, {
      args: input.args,
      ctx,
      systemPrompt: this.options.systemPrompt,
      onForkUsage: this.options.onForkUsage,
    })
  }
}
