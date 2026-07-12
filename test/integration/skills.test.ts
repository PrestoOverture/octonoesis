// biome-ignore lint/suspicious/noExplicitAny: Bun globals are provided by the test runtime.
declare const Bun: any

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { flushJournal } from '../../src/memory/journal'
import {
  clearAllowlist,
  registerPromptHandler,
  unregisterPromptHandler,
} from '../../src/permissions/confirm'
import type { SkillDefinition } from '../../src/skills/types'
import { bashTool } from '../../src/tools/Bash'
import { editTool } from '../../src/tools/Edit'
import { globTool } from '../../src/tools/Glob'
import { grepTool } from '../../src/tools/Grep'
import { readTool } from '../../src/tools/Read'
import { SkillTool } from '../../src/tools/SkillTool'
import { todoWriteTool } from '../../src/tools/TodoWrite'
import { writeTool } from '../../src/tools/Write'
import { runTool } from '../../src/tools/execute'
import { clearRegistry, registerTool } from '../../src/tools/registry'

const originalMain = Bun.main
const originalCwd = process.cwd()
const originalMock = process.env.OCTONOESIS_FORK_MOCK
const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
const roots: string[] = []

afterEach(async () => {
  unregisterPromptHandler()
  clearAllowlist()
  clearRegistry()
  for (const tool of [readTool, globTool, bashTool, writeTool, editTool, grepTool, todoWriteTool]) {
    registerTool(tool)
  }
  Bun.main = originalMain
  process.chdir(originalCwd)
  if (originalMock === undefined) Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_MOCK')
  else process.env.OCTONOESIS_FORK_MOCK = originalMock
  if (originalMemoryDir === undefined) Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  else process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function definition(context: 'inline' | 'fork', repoRoot: string): SkillDefinition {
  return {
    name: `${context}-skill`,
    description: `${context} test`,
    context,
    ...(context === 'fork' ? { allowedTools: ['Read'] } : {}),
    content: context === 'fork' ? 'Read package.json and report it.' : 'Follow these instructions.',
    source: 'project',
    path: path.join(repoRoot, `${context}-skill.md`),
  }
}

describe('skill integration', () => {
  test('inline invocation bypasses permission and journals schema v2', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'inline-skill-'))
    roots.push(root)
    const memoryDir = path.join(root, 'memory')
    process.env.OCTONOESIS_MEMORY_DIR = memoryDir
    let prompted = false
    registerPromptHandler(async () => {
      prompted = true
      return 'allow_once'
    })
    registerTool(new SkillTool([definition('inline', root)], { systemPrompt: 'stable' }))

    const result = await runTool(
      'Skill',
      { skill: 'inline-skill', args: 'be concise' },
      { repoRoot: root },
    )
    await flushJournal()

    expect(result).toEqual({
      ok: true,
      value: 'Follow these instructions.\n\nArguments: be concise',
    })
    expect(prompted).toBe(false)
    const events = (await readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const skillEvents = events.filter((event) => event.kind === 'skill')
    expect(skillEvents.length).toBe(1)
    expect(skillEvents[0]?.context).toBe('inline')
    expect(skillEvents[0]?.skill).toBe('inline-skill')
    expect(skillEvents[0]?.schema_version).toBe(2)
  })

  test('fork invocation prompts, executes Read in a real child, and journals once', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fork-skill-'))
    roots.push(root)
    await writeFile(path.join(root, 'package.json'), '{"childCanary":"seen"}')
    const memoryDir = path.join(root, 'memory-outside-child-repo')
    process.env.OCTONOESIS_MEMORY_DIR = memoryDir
    process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({
      scriptedEvents: [
        [
          { type: 'tool_use', id: 'read-1', name: 'Read', input: { path: 'package.json' } },
          { type: 'message_end', usage: { input_tokens: 2, output_tokens: 1 } },
        ],
        [
          { type: 'text_delta', text: 'Observed {{tool_result}}' },
          { type: 'message_end', usage: { input_tokens: 3, output_tokens: 2 } },
        ],
      ],
    })
    Bun.main = path.join(originalCwd, 'src/cli.tsx')
    process.chdir(root)
    let prompted = 0
    registerPromptHandler(async () => {
      prompted++
      return 'allow_once'
    })
    registerTool(readTool)
    registerTool(new SkillTool([definition('fork', root)], { systemPrompt: 'parent stable' }))

    const result = await runTool('Skill', { skill: 'fork-skill' }, { repoRoot: root })
    await flushJournal()

    expect(result.ok).toBe(true)
    expect(result.ok && String(result.value)).toContain('childCanary')
    expect(prompted).toBe(1)
    expect(await Bun.file(path.join(root, '.octonoesis')).exists()).toBe(false)
    const journal = await readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8')
    const skills = journal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.kind === 'skill')
    expect(skills.length).toBe(1)
    expect(skills[0]?.context).toBe('fork')
    expect(skills[0]?.skill).toBe('fork-skill')
    expect(skills[0]?.schema_version).toBe(2)
  })
})
