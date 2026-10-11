import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { markMemoryAvailability, resetMemoryAvailability } from '../../src/memory/availability'
import { appendEpisodes } from '../../src/memory/episodes/store'
import { flushJournal } from '../../src/memory/journal'
import { loadRule, saveRule } from '../../src/memory/rules/store'
import { assembleSessionContext } from '../../src/prompts/context'
import { setProvider } from '../../src/providers'
import {
  type QueryResult,
  type StreamEvent,
  query,
  recordRuleOutcome,
} from '../../src/query/engine'
import baseline from '../fixtures/ui3-main-ledger.json'
import { restoreEnv } from '../helpers/env'
import { learningScript, promptText, seededRule } from '../helpers/learningScript'

let root = ''
let saved: Record<string, string | undefined>
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ui3-learning-')))
  const env = {
    OCTONOESIS_MEMORY_DIR: path.join(root, 'memory'),
    OCTONOESIS_REPO_ROOT: root,
    OCTONOESIS_DISABLE_MEMORY: undefined,
    OCTONOESIS_DISABLE_AUTO_DISTILL: '1',
    OCTONOESIS_DISABLE_COMPACT: '1',
  }
  saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) restoreEnv(key, value)
  resetMemoryAvailability()
})
afterEach(async () => {
  setProvider(null)
  resetMemoryAvailability()
  await flushJournal()
  await fs.rm(root, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) restoreEnv(key, value)
})
async function collect(generator: AsyncGenerator<StreamEvent, QueryResult, undefined>) {
  const events: StreamEvent[] = []
  let next = await generator.next()
  while (!next.done) {
    events.push(next.value)
    next = await generator.next()
  }
  return { events, result: next.value }
}
const learning = (event: StreamEvent) =>
  ['rule_recall', 'rule_outcome', 'rules_learned'].includes(event.type)
function replyProvider() {
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      yield { type: 'text_delta', text: 'Done.' }
      yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
    },
  })
}
test('failure recall and hit preserve main ledger, messages, and model input', async () => {
  const actual = await learningScript(root)
  expect(actual.result.exit_reason).toBe('completed')
  const recall = actual.events.find((e) => e.type === 'rule_recall' && e.trigger === 'failure')
  expect(recall).toEqual({
    type: 'rule_recall',
    trigger: 'failure',
    toolUseId: 'fail',
    rules: [{ id: 'rule-fix', confidence: 0.6 }],
  })
  const outcome = actual.events.find((e) => e.type === 'rule_outcome')
  expect(outcome).toEqual({
    type: 'rule_outcome',
    id: 'rule-fix',
    hit: true,
    before: 0.6,
    after: 0.6667,
  })
  if (!recall || !outcome) throw new Error('Missing learning events')
  expect(actual.events.indexOf(recall)).toBeLessThan(actual.events.indexOf(outcome))
  const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(root, '<repo>'))
  expect(normalize(actual.ledger)).toEqual(baseline.ledger)
  expect(normalize(actual.messages)).toEqual(baseline.messages)
  // Compare the stable system prompt and canonical provider messages against main.
  const inputs = JSON.stringify(normalize(actual.inputs)).replace(/\d{4}-\d{2}-\d{2}/g, '<date>')
  expect(JSON.parse(inputs)).toEqual(baseline.inputs)
})
test('outcome write throws, query still completes identically without an outcome line', async () => {
  const actual = await learningScript(root, true)
  await expect(recordRuleOutcome('rule-fix', false, root)).rejects.toThrow()
  expect(actual.result).toEqual({
    exit_reason: 'completed',
    final_message: 'Fixed.',
    turns: 5,
    usage: { input_tokens: 5, output_tokens: 5 },
  })
  expect(actual.events.filter((e) => e.type === 'rule_outcome')).toEqual([])
  expect(actual.ledger.hits).toBe(0)
})
test('compiler exposes injected ids; first query recalls them once; resume does not replay', async () => {
  const rules = [seededRule('rule-a'), seededRule('rule-b'), seededRule('rule-c')]
  for (const rule of rules) await saveRule(rule)
  const ctx = { repoRoot: root, messages: [] }
  const compiled = await assembleSessionContext(
    ctx,
    'test',
    { input_tokens: 0, output_tokens: 0 },
    [],
    [],
    rules,
  )
  expect(compiled.sessionStartRuleIds).toEqual(rules.map((rule) => rule.id))
  replyProvider()
  const first = await collect(query('hello', ctx))
  expect(first.events.filter(learning)).toEqual([
    {
      type: 'rule_recall',
      trigger: 'session_start',
      rules: rules.map(({ id }) => ({ id, confidence: 0.6 })),
    },
  ])
  expect((await collect(query('again', ctx))).events.filter(learning)).toEqual([])
  const resumed = { repoRoot: root, messages: structuredClone(ctx.messages) }
  expect((await collect(query('resumed', resumed))).events.filter(learning)).toEqual([])
})
for (const mode of ['disabled', 'unusable', 'empty'])
  test(`${mode} memory emits no learning events`, async () => {
    if (mode !== 'empty') await saveRule(seededRule())
    if (mode === 'disabled') process.env.OCTONOESIS_DISABLE_MEMORY = '1'
    if (mode === 'unusable') markMemoryAvailability({ usable: false, dir: root, code: 'EACCES' })
    replyProvider()
    expect((await collect(query('hello', { repoRoot: root }))).events.filter(learning)).toEqual([])
  })
test('distillation yields persisted candidate before completion and reports later strengthening', async () => {
  restoreEnv('OCTONOESIS_DISABLE_AUTO_DISTILL', undefined)
  await fs.writeFile(path.join(root, 'bug.txt'), 'fixed')
  const episode = {
    id: 'ep_0001',
    timestamp: new Date().toISOString(),
    session_id: 'learned',
    task_digest: 'fix',
    failure: {
      tool: 'Bash',
      cmd: 'bun test',
      error_class: 'TypeError',
      signature: 'bash|TypeError|bug.txt|broken',
    },
    fix_candidates: [{ tool: 'Edit', path: 'bug.txt', summary: 'fixed', role: 'direct' as const }],
    attribution: { status: 'single_direct' as const, primary: 'bug.txt', confidence: 0.9 },
    verification: { cmd: 'bun test', exit_code: 0 },
    outcome: 'resolved' as const,
    journal_line_range: { start: 1, end: 3 },
    value_score: 1,
    is_excluded: false,
    exclusion_reason: null,
  }
  await appendEpisodes([episode])
  setProvider({
    name: 'anthropic',
    async *createMessageStream(messages) {
      yield {
        type: 'text_delta',
        text: promptText(messages).includes('expert software engineering mentor')
          ? JSON.stringify({
              slug: 'new',
              triggers: {
                tools: ['Bash'],
                command_prefix: ['bun test'],
                error_signatures: [episode.failure.signature],
              },
              anchor_file: 'bug.txt',
              advice: 'Fix broken.',
            })
          : 'Done.',
      }
      yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
    },
  })
  const ctx = {
    repoRoot: root,
    sessionId: 'learned',
    persistSession: true,
    memoryDir: path.join(root, 'memory'),
  }
  const first = await collect(query('learn', ctx))
  expect(first.events.filter(learning)).toEqual([
    { type: 'rules_learned', created: [{ id: 'rule-new', status: 'candidate' }], updated: 0 },
  ])
  expect((await loadRule('rule-new'))?.status).toBe('candidate')
  await appendEpisodes([{ ...episode, id: 'ep_0002' }])
  expect((await collect(query('strengthen', ctx))).events.filter(learning)).toEqual([
    { type: 'rules_learned', created: [], updated: 1 },
  ])
  // A consumer closing early must not strand persistence after a finally yield.
  const snapshot = path.join(ctx.memoryDir, 'sessions', 'learned.json')
  await fs.rm(snapshot)
  await appendEpisodes([{ ...episode, id: 'ep_0003' }])
  const closing = query('close early', ctx)
  await closing.next()
  const returned = await closing.return({
    exit_reason: 'user_cancel',
    usage: { input_tokens: 0, output_tokens: 0 },
    turns: 0,
  })
  expect(returned.done).toBe(false)
  expect(returned.value).toEqual({ type: 'rules_learned', created: [], updated: 1 })
  expect(JSON.parse(await fs.readFile(snapshot, 'utf8')).session_id).toBe('learned')
  expect((await closing.next()).done).toBe(true)
})
test('outcome returns real fresh confidence and undefined for a deleted rule', async () => {
  await fs.writeFile(path.join(root, 'bug.txt'), 'fixed')
  await saveRule(seededRule())
  expect(await recordRuleOutcome('rule-fix', true, root)).toEqual({
    hit: false,
    before: 0.6,
    after: 0.5,
  })
  expect(await recordRuleOutcome('gone', false, root)).toBeUndefined()
})
