import { describe, expect, test } from 'bun:test'
import type { SkillDefinition } from '../../../src/skills/types'
import { SkillTool } from '../../../src/tools/SkillTool'

const inline: SkillDefinition = {
  name: 'explain',
  description: 'Explain something',
  context: 'inline',
  content: 'Explain carefully.',
  source: 'project',
  path: 'explain.md',
}

describe('SkillTool', () => {
  test('returns inline content with arguments and rejects unknown names', async () => {
    const tool = new SkillTool([inline], { systemPrompt: 'parent' })
    expect(tool.isReadOnly({ skill: 'explain' })).toBe(true)
    expect(
      await tool.call(
        { skill: 'explain', args: 'the parser' },
        { repoRoot: process.cwd(), abortSignal: new AbortController().signal },
      ),
    ).toEqual({ ok: true, value: 'Explain carefully.\n\nArguments: the parser' })
    expect(
      await tool.call(
        { skill: 'missing' },
        { repoRoot: process.cwd(), abortSignal: new AbortController().signal },
      ),
    ).toEqual({ ok: false, error: 'Unknown skill: missing' })
  })
})
