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

  constructor(
    skills: readonly SkillDefinition[],
    private readonly options: SkillToolOptions,
  ) {
    this.skills = new Map(skills.map((skill) => [skill.name, skill]))
  }

  isConcurrencySafe(): boolean {
    return false
  }

  isReadOnly(input: SkillInput): boolean {
    return this.skills.get(input.skill)?.context !== 'fork'
  }

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
