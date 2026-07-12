export type SkillContext = 'inline' | 'fork'
export type SkillSource = 'bundled' | 'project' | 'user'

export interface SkillDefinition {
  name: string
  description: string
  allowedTools?: string[]
  context: SkillContext
  model?: string
  content: string
  source: SkillSource
  path: string
}
