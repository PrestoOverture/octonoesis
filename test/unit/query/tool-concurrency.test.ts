import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { HookRegistry } from '../../../src/hooks/registry'
import { flushJournal, setSessionId } from '../../../src/memory/journal'
import { loadRule, saveRule } from '../../../src/memory/rules/store'
import { registerPromptHandler, unregisterPromptHandler } from '../../../src/permissions/confirm'
import { setProvider } from '../../../src/providers'
import type { ContentBlock } from '../../../src/providers/types'
import { type StreamEvent, executeTools } from '../../../src/query/engine'
import type { QueryLoopContext } from '../../../src/query/types'
import { bashTool } from '../../../src/tools/Bash'
import { editTool } from '../../../src/tools/Edit'
import { readTool } from '../../../src/tools/Read'
import type { Tool, ToolResult } from '../../../src/tools/Tool'
import { registerTool, unregisterTool } from '../../../src/tools/registry'
import { restoreEnv } from '../../helpers/env'
import { seededRule } from '../../helpers/learningScript'

const inputSchema = z.object({
  id: z.string(),
  delay: z.number().default(0),
  write: z.boolean().optional(),
})
type Input = z.infer<typeof inputSchema>
let directory: string
let savedMemoryDir: string | undefined
let savedDisableMemory: string | undefined
const registered: Tool[] = []

beforeEach(async () => {
  savedMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
  savedDisableMemory = process.env.OCTONOESIS_DISABLE_MEMORY
  restoreEnv('OCTONOESIS_DISABLE_MEMORY', undefined)
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tool-concurrency-')))
  process.env.OCTONOESIS_MEMORY_DIR = directory
  setSessionId('tool-concurrency')
})

afterEach(async () => {
  unregisterPromptHandler()
  setProvider(null)
  restoreEnv('OCTONOESIS_DISABLE_MEMORY', savedDisableMemory)
  for (const tool of registered.splice(0)) unregisterTool(tool.name, tool)
  await flushJournal()
  restoreEnv('OCTONOESIS_MEMORY_DIR', savedMemoryDir)
  await fs.rm(directory, { recursive: true, force: true })
})

function mockTool(
  name: string,
  call: (input: Input, ctx: QueryLoopContext) => Promise<ToolResult>,
  safe = true,
) {
  const tool: Tool<Input> = {
    name,
    description: 'concurrency test',
    inputSchema,
    isConcurrencySafe: () => safe,
    isReadOnly: (input) => !input.write,
    call,
  }
  registerTool(tool)
  registered.push(tool as Tool)
}

function call(id: string, name = 'ConcurrentRead', delay = 0, write = false): ContentBlock {
  return { type: 'tool_use', id, name, input: { id, delay, write } }
}

function harness(signal?: AbortSignal, hooks = new HookRegistry()) {
  const ctx: QueryLoopContext = {
    repoRoot: directory,
    sessionId: 'tool-concurrency',
    messages: [],
    hooks,
    abortSignal: signal,
    injectedRules: [],
    recordedRuleOutcomes: new Set(),
  }
  const state: Parameters<typeof executeTools>[0] = {
    turn: 1,
    messages: ctx.messages ?? [],
    usage: { input_tokens: 0, output_tokens: 0 },
    model: 'mock',
    sessionId: 'tool-concurrency',
    repoRoot: directory,
    injectedRules: ctx.injectedRules ?? [],
    recordedRuleOutcomes: ctx.recordedRuleOutcomes ?? new Set(),
    tasks: new Map(),
    hooks,
    input: '',
    inputDigest: '',
    rules: [],
    compactConsecutiveFailures: 0,
    compactCircuitOpen: false,
    emitSessionState: false,
    system: '',
    dynamicSystem: '',
    tools: [],
    provider: { name: 'anthropic', async *createMessageStream() {} },
  }
  return {
    ctx,
    state,
    async run(calls: ContentBlock[]) {
      const events: StreamEvent[] = []
      const generator = executeTools(state, ctx, calls)
      let step = await generator.next()
      while (!step.done) {
        events.push(step.value)
        step = await generator.next()
      }
      return { events, result: step.value }
    },
  }
}

function results(state: Parameters<typeof executeTools>[0]) {
  return state.messages.filter((message) => message.role === 'tool')
}

async function journal() {
  await flushJournal()
  return (await fs.readFile(path.join(directory, 'journal.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test('three 200ms read-only calls finish under 400ms and retain call order', async () => {
  mockTool('ConcurrentRead', async ({ id, delay }) => {
    await sleep(delay)
    return { ok: true, value: id }
  })
  const h = harness()
  const started = performance.now()
  const { events } = await h.run([
    call('one', undefined, 200),
    call('two', undefined, 200),
    call('three', undefined, 200),
  ])
  expect(performance.now() - started).toBeLessThan(400)
  expect(results(h.state).map((message) => message.content)).toEqual(['one', 'two', 'three'])
  expect(events.filter((event) => event.type === 'tool_done').map((event) => event.id)).toEqual([
    'one',
    'two',
    'three',
  ])
})

test('scheduler and executor both accept shallow scalar strings for safe read-only calls', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let ready!: () => void
  const bothStarted = new Promise<void>((resolve) => {
    ready = resolve
  })
  const started: string[] = []
  mockTool('CoercedConcurrentRead', async (input) => {
    expect(input.delay).toBe(0)
    expect(input.write).toBe(false)
    started.push(input.id)
    if (started.length === 2) ready()
    await gate
    return { ok: true, value: input.id }
  })
  const h = harness()
  const running = h.run(
    ['one', 'two'].map((id) => ({
      type: 'tool_use' as const,
      id,
      name: 'CoercedConcurrentRead',
      input: { id, delay: '0', write: 'false' },
    })),
  )
  try {
    await Promise.race([bothStarted, sleep(1000)])
    expect(started).toEqual(['one', 'two'])
  } finally {
    release()
    await running
  }
  expect(results(h.state).map((message) => message.content)).toEqual(['one', 'two'])
})

test('Read, Edit, Read executes strictly across the non-safe barrier', async () => {
  const order: string[] = []
  const execute = async ({ id }: Input): Promise<ToolResult> => {
    order.push(`start:${id}`)
    await sleep(10)
    order.push(`end:${id}`)
    return { ok: true, value: id }
  }
  mockTool('ConcurrentRead', execute)
  mockTool('ConcurrentEdit', execute, false)
  registerPromptHandler(async () => 'allow_once')
  await harness().run([call('read1'), call('edit', 'ConcurrentEdit', 0, true), call('read2')])
  expect(order).toEqual([
    'start:read1',
    'end:read1',
    'start:edit',
    'end:edit',
    'start:read2',
    'end:read2',
  ])
})

test('at most ten calls run at once, including batches larger than ten', async () => {
  let active = 0
  let maximum = 0
  mockTool('ConcurrentRead', async ({ id }) => {
    maximum = Math.max(maximum, ++active)
    await sleep(10)
    active--
    return { ok: true, value: id }
  })
  const h = harness()
  await h.run(Array.from({ length: 23 }, (_, index) => call(String(index))))
  expect(maximum).toBe(10)
  expect(results(h.state).map((message) => message.tool_use_id)).toEqual(
    Array.from({ length: 23 }, (_, index) => String(index)),
  )
})

test('out-of-order completion preserves journal and post-hook order and history visibility', async () => {
  const completed: string[] = []
  const postCalls: string[] = []
  mockTool('ConcurrentRead', async ({ id, delay }) => {
    await sleep(delay)
    completed.push(id)
    return { ok: true, value: id }
  })
  const hooks = new HookRegistry()
  hooks.register({
    event: 'pre_tool_use',
    handler: { type: 'function', fn: async () => undefined },
  })
  hooks.register({
    event: 'post_tool_use',
    handler: {
      type: 'function',
      fn: async ({ payload, state }) => {
        const input = payload.input as Input
        postCalls.push(input.id)
        expect(state?.messages.filter((message) => message.role === 'tool').length).toBe(
          postCalls.length,
        )
        return undefined
      },
    },
  })
  await harness(undefined, hooks).run([
    call('one', undefined, 60),
    call('two', undefined, 20),
    call('three', undefined, 1),
  ])
  expect(completed).toEqual(['three', 'two', 'one'])
  expect(postCalls).toEqual(['one', 'two', 'three'])
  const rows = await journal()
  const timestamps = rows.map((row) => String(row.ts))
  expect(timestamps).toEqual([...timestamps].sort())
  expect(rows.map((row) => (row.kind === 'hook' ? row.hook_event : row.kind))).toEqual([
    'pre_tool_use',
    'tool',
    'post_tool_use',
    'pre_tool_use',
    'tool',
    'post_tool_use',
    'pre_tool_use',
    'tool',
    'post_tool_use',
  ])
})

test('safe tools requiring permission are barriers and never overlap prompts or executions', async () => {
  let active = 0
  let prompts = 0
  const order: string[] = []
  mockTool('ConcurrentRead', async ({ id }) => {
    expect(prompts).toBe(0)
    expect(active++).toBe(0)
    order.push(id)
    await sleep(10)
    active--
    return { ok: true, value: id }
  })
  registerPromptHandler(async (_name, input) => {
    expect(active).toBe(0)
    expect(prompts++).toBe(0)
    order.push(`prompt:${(input as Input).id}`)
    await sleep(10)
    prompts--
    return 'allow_once'
  })
  await harness().run([
    call('read1'),
    call('write1', undefined, 0, true),
    call('write2', undefined, 0, true),
    call('read2'),
  ])
  expect(order).toEqual(['read1', 'prompt:write1', 'write1', 'prompt:write2', 'write2', 'read2'])
})

test('pre-hook input changes cannot introduce concurrent permission prompts', async () => {
  mockTool('ConcurrentRead', async ({ id }) => ({ ok: true, value: id }))
  const hooks = new HookRegistry()
  hooks.register({
    event: 'pre_tool_use',
    handler: {
      type: 'function',
      fn: async ({ payload }) => {
        ;(payload.input as Input).write = true
        return undefined
      },
    },
  })
  let prompts = 0
  registerPromptHandler(async () => {
    expect(prompts++).toBe(0)
    await sleep(10)
    prompts--
    return 'allow_once'
  })
  await harness(undefined, hooks).run([call('one'), call('two')])
  expect((await journal()).filter((row) => row.kind === 'permission').length).toBe(2)
})

test('abort signals every in-flight call and pairs all calls including unstarted ones', async () => {
  const controller = new AbortController()
  let started = 0
  let aborted = 0
  mockTool('ConcurrentRead', async ({ id }, ctx) => {
    if (id === 'finished') return { ok: true, value: 'finished' }
    started++
    return new Promise<ToolResult>((resolve) => {
      ctx.abortSignal?.addEventListener(
        'abort',
        () => {
          aborted++
          resolve({ ok: false, error: 'cancelled' })
        },
        { once: true },
      )
      if (started === 9) controller.abort()
    })
  })
  const h = harness(controller.signal)
  const calls = [call('finished'), ...Array.from({ length: 12 }, (_, index) => call(String(index)))]
  const { result, events } = await h.run(calls)
  expect(started).toBe(9)
  expect(aborted).toBe(9)
  expect(result.restartLoop).toBe(true)
  expect(results(h.state).length).toBe(13)
  expect(results(h.state).map((message) => message.tool_use_id)).toEqual(
    calls.map((block) => (block.type === 'tool_use' ? block.id : '')),
  )
  expect(results(h.state)[0]?.content).toBe('finished')
  for (const message of results(h.state).slice(1))
    expect(JSON.stringify(message.content)).toContain('cancelled')
  expect(events.filter((event) => event.type === 'tool_done').length).toBe(13)
})

test('Bash fingerprints, rule injection, and verification stay ordered between concurrent batches', async () => {
  await fs.writeFile(path.join(directory, 'bug.txt'), 'broken')
  const rule = seededRule()
  await saveRule(rule)
  registerTool(bashTool)
  registerPromptHandler(async () => 'allow_once')
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      yield {
        type: 'text_delta',
        text: JSON.stringify({
          tool: 'bash',
          error_class: 'TypeError',
          file: 'bug.txt',
          expression: 'broken',
        }),
      }
      yield {
        type: 'message_end',
        stopReason: 'end_turn' as const,
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    },
  })
  mockTool('ConcurrentRead', async ({ id, delay }) => {
    await sleep(delay)
    return { ok: true, value: id }
  })
  const h = harness()
  h.state.rules = [rule]
  const command = `if [ "$(cat bug.txt)" = fixed ]; then echo passed; else echo 'TypeError: broken at bug.txt'; exit 1; fi`
  const bash = (id: string, command: string): ContentBlock => ({
    type: 'tool_use',
    id,
    name: 'Bash',
    input: { command },
  })
  const calls = [
    call('one', undefined, 20),
    call('two'),
    bash('fail', command),
    call('three', undefined, 20),
    call('four'),
    bash('fix', 'printf fixed > bug.txt'),
    bash('verify', command),
    call('five', undefined, 20),
    call('six'),
  ]
  const { events } = await h.run(calls)
  expect(results(h.state).map((message) => message.tool_use_id)).toEqual([
    'one',
    'two',
    'fail',
    'three',
    'four',
    'fix',
    'verify',
    'five',
    'six',
  ])
  expect(JSON.stringify(results(h.state)[2]?.content)).toContain('<octo-memory>')
  expect(h.ctx.injectedRules?.length).toBe(1)
  expect(h.ctx.recordedRuleOutcomes?.has(rule.id)).toBe(true)
  expect((await loadRule(rule.id))?.hits).toBe(1)
  expect(
    events
      .filter((event) => event.type === 'rule_recall' || event.type === 'rule_outcome')
      .map((event) => event.type),
  ).toEqual(['rule_recall', 'rule_outcome'])
  const rows = await journal()
  expect(rows.filter((row) => row.kind === 'tool').map((row) => row.tool)).toEqual([
    'ConcurrentRead',
    'ConcurrentRead',
    'Bash',
    'ConcurrentRead',
    'ConcurrentRead',
    'Bash',
    'Bash',
    'ConcurrentRead',
    'ConcurrentRead',
  ])
  expect(rows.filter((row) => row.kind === 'verify').map((row) => row.verdict)).toEqual(['PASS'])
})

test('abort yields cancellation results even when a tool ignores its abort signal', async () => {
  const controller = new AbortController()
  let started = 0
  mockTool('ConcurrentRead', async () => {
    if (++started === 3) controller.abort()
    return new Promise<ToolResult>(() => {})
  })
  const h = harness(controller.signal)
  await h.run([call('one'), call('two'), call('three')])
  expect(results(h.state).length).toBe(3)
  for (const message of results(h.state))
    expect(JSON.stringify(message.content)).toContain('cancelled')
})

test('real Read calls share the edit-safety cache across a subsequent Edit barrier', async () => {
  await fs.writeFile(path.join(directory, 'shared.txt'), 'before')
  for (const tool of [readTool, editTool]) registerTool(tool)
  registerPromptHandler(async () => 'allow_once')
  const h = harness()
  await h.run([
    { type: 'tool_use', id: 'read1', name: 'Read', input: { path: 'shared.txt' } },
    { type: 'tool_use', id: 'read2', name: 'Read', input: { path: 'shared.txt' } },
    {
      type: 'tool_use',
      id: 'edit',
      name: 'Edit',
      input: { path: 'shared.txt', old_string: 'before', new_string: 'after' },
    },
    { type: 'tool_use', id: 'read3', name: 'Read', input: { path: 'shared.txt' } },
  ])
  expect(await fs.readFile(path.join(directory, 'shared.txt'), 'utf8')).toBe('after')
  expect(results(h.state).map((message) => message.tool_use_id)).toEqual([
    'read1',
    'read2',
    'edit',
    'read3',
  ])
  expect(results(h.state)[3]?.content).toBe('1\tafter')
})
