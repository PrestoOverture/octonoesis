import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { rewriteSkillSlashCommand } from '../../../src/skills/execute'
import { clearSkillCacheForTesting } from '../../../src/skills/loader'

let root = ''
afterEach(async () => {
  clearSkillCacheForTesting()
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

describe('rewriteSkillSlashCommand', () => {
  test('rewrites known commands and preserves unknown or plain input byte-for-byte', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'skill-slash-'))
    const dir = path.join(root, '.octonoesis/skills')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'audit.md'), '---\ndescription: Audit\n---\nbody')

    expect(await rewriteSkillSlashCommand('/audit check src', root)).toBe(
      'Invoke the skill "audit" via the Skill tool with args: check src',
    )
    expect(await rewriteSkillSlashCommand('/audit', root)).toBe(
      'Invoke the skill "audit" via the Skill tool.',
    )
    expect(await rewriteSkillSlashCommand('/missing x', root)).toBe('/missing x')
    expect(await rewriteSkillSlashCommand(' /audit', root)).toBe(' /audit')
  })
})
