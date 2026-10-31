import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { flushJournal } from '../../../../src/memory/journal'
import { getRulesArchiveDir, loadRule, saveRule } from '../../../../src/memory/rules/store'
import type { RuleFile } from '../../../../src/memory/rules/types'
import { recordRuleOutcome } from '../../../../src/query/engine'

let dir: string
const originalDir = process.env.OCTONOESIS_MEMORY_DIR
const originalSwitch = process.env.OCTONOESIS_DISABLE_RULE_UTILITY
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rule-utility-'))
  process.env.OCTONOESIS_MEMORY_DIR = dir
  Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_RULE_UTILITY')
  await fs.writeFile(path.join(dir, 'anchor.ts'), '')
  await saveRule(
    {
      id: 'rule-utility',
      triggers: { tools: ['Bash'], command_prefix: [], error_signatures: ['test|Error'] },
      scope: 'repo',
      alpha: 3,
      beta: 2,
      confidence: 0.6,
      evidence: ['ep_1'],
      hits: 0,
      misses: 0,
      challenged_by: [],
      anchor: { file: 'anchor.ts' },
      status: 'candidate',
      user_confirmed: false,
      extractor_version: 'test',
      model_id: 'mock',
      prompt_hash: 'test',
      created_at: new Date().toISOString(),
      last_matched_at: null,
      last_rebuilt_at: null,
      advice: 'Inspect the contract.',
    } satisfies RuleFile,
    path.join(dir, 'rules'),
  )
})
afterEach(async () => {
  await flushJournal()
  await fs.rm(dir, { recursive: true, force: true })
  if (originalDir === undefined) Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  else process.env.OCTONOESIS_MEMORY_DIR = originalDir
  if (originalSwitch === undefined)
    Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_RULE_UTILITY')
  else process.env.OCTONOESIS_DISABLE_RULE_UTILITY = originalSwitch
})
const outcome = (miss: boolean, session: string) =>
  recordRuleOutcome('rule-utility', miss, dir, path.join(dir, 'rules'), session)
const hot = () => loadRule('rule-utility', path.join(dir, 'rules'))

test('one miss, including repeated queries in one noisy session, cannot retire', async () => {
  for (let i = 0; i < 15; i++) await outcome(true, 'same-session')
  expect((await hot())?.status).toBe('candidate')
  expect((await hot())?.utility?.misses).toBe(1)
  expect((await hot())?.utility?.sessions.length).toBe(1)
})
test('eight independent misses archive with persisted reason and journal the transition', async () => {
  for (let i = 0; i < 8; i++) await outcome(true, `session-${i}`)
  expect(await hot()).toBe(null)
  const archived = await loadRule('rule-utility', getRulesArchiveDir(path.join(dir, 'rules')))
  expect(archived?.status).toBe('retired')
  expect(archived?.retirement_reason).toContain('poor verified-recovery utility')
  expect(archived?.utility?.misses).toBe(8)
  await flushJournal()
  const events = (await fs.readFile(path.join(dir, 'journal.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(events.at(-1)).toMatchObject({
    kind: 'rule_utility',
    status: 'retired',
    sessions: 8,
    hit: false,
  })
  expect(events.at(-1).reason).toBe(archived?.retirement_reason)
})
test('good independent utility promotes and mixed poor utility demotes', async () => {
  for (let i = 0; i < 8; i++) await outcome(false, `session-${i}`)
  expect((await hot())?.status).toBe('active')
  for (let i = 8; i < 17; i++) await outcome(true, `session-${i}`)
  expect((await hot())?.status).toBe('candidate')
})
test('feature switch disables utility decisions and records the setting', async () => {
  process.env.OCTONOESIS_DISABLE_RULE_UTILITY = '1'
  for (let i = 0; i < 10; i++) await outcome(true, `session-${i}`)
  expect((await hot())?.utility).toBeUndefined()
  expect((await hot())?.status).toBe('candidate')
  await flushJournal()
  expect(await fs.readFile(path.join(dir, 'journal.jsonl'), 'utf8')).toContain('"enabled":false')
})
test('ledger I/O failures are best effort', async () => {
  const blocked = path.join(dir, 'blocked')
  await fs.writeFile(blocked, '')
  expect(
    await recordRuleOutcome('rule-utility', true, dir, path.join(blocked, 'rules'), 'session'),
  ).toBeUndefined()
})
