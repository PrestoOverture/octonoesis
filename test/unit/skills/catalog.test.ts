import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HookRegistry } from '../../../src/hooks/registry'
import {
  assembleSessionContext,
  buildSessionContextSources,
  formatSkillCatalog,
} from '../../../src/prompts/context'
import type { SkillDefinition } from '../../../src/skills/types'

function definition(
  name: string,
  description: string,
  context: 'inline' | 'fork',
): SkillDefinition {
  return { name, description, context, content: '', source: 'project', path: `${name}.md` }
}

describe('formatSkillCatalog', () => {
  test('documents invocation and lists skills in stable order', () => {
    expect(
      formatSkillCatalog([
        definition('zeta', 'Last', 'inline'),
        definition('audit', 'Check the repo', 'fork'),
      ]),
    ).toBe(
      '## Skills\nUse the Skill tool to invoke a skill by name. Pass any user-supplied trailing text as args.\n\n- audit: Check the repo [fork]\n- zeta: Last',
    )
  })

  test('emits a low-priority stable-system source iff skills exist', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'skill-catalog-'))
    process.env.OCTONOESIS_MEMORY_DIR = path.join(root, 'memory')
    const ctx = { repoRoot: root, tasks: new Map(), hooks: new HookRegistry() }
    try {
      const empty = await buildSessionContextSources(
        ctx,
        'claude-haiku-4-5-20251001',
        { input_tokens: 0, output_tokens: 0 },
        [],
      )
      const populated = await buildSessionContextSources(
        ctx,
        'claude-haiku-4-5-20251001',
        { input_tokens: 0, output_tokens: 0 },
        [],
        [definition('zeta', 'Last', 'inline'), definition('audit', 'First', 'fork')],
      )
      expect(empty.some((source) => source.id === 'skill_catalog')).toBe(false)
      const catalog = populated.find((source) => source.id === 'skill_catalog')
      expect(catalog?.channel).toBe('systemStable')
      expect(catalog?.priority).toBe('low')
      expect(catalog?.content.indexOf('- audit')).toBeLessThan(
        catalog?.content.indexOf('- zeta') ?? -1,
      )
      const repeated = await buildSessionContextSources(
        ctx,
        'claude-haiku-4-5-20251001',
        { input_tokens: 0, output_tokens: 0 },
        [],
        [definition('zeta', 'Last', 'inline'), definition('audit', 'First', 'fork')],
      )
      expect(repeated.find((source) => source.id === 'skill_catalog')?.content).toBe(
        catalog?.content,
      )
      const firstCompiled = await assembleSessionContext(
        ctx,
        'claude-haiku-4-5-20251001',
        { input_tokens: 0, output_tokens: 0 },
        [],
        [definition('zeta', 'Last', 'inline'), definition('audit', 'First', 'fork')],
      )
      const secondCompiled = await assembleSessionContext(
        ctx,
        'claude-haiku-4-5-20251001',
        { input_tokens: 0, output_tokens: 0 },
        [],
        [definition('zeta', 'Last', 'inline'), definition('audit', 'First', 'fork')],
      )
      expect(firstCompiled.systemStable).toContain('## Skills')
      expect(firstCompiled.systemStable).toBe(secondCompiled.systemStable)
    } finally {
      Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
      await rm(root, { recursive: true, force: true })
    }
  })
})
