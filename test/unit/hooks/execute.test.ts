import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { executeHooks } from '../../../src/hooks/execute'
import { HookRegistry } from '../../../src/hooks/registry'
import { flushJournal } from '../../../src/memory/journal'

const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
let root = ''

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hook-execute-'))
  process.env.OCTONOESIS_MEMORY_DIR = path.join(root, 'memory')
})

afterEach(async () => {
  await flushJournal()
  await rm(root, { recursive: true, force: true })
  if (originalMemoryDir === undefined) Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  else process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
})

async function hookJournal(): Promise<Array<Record<string, unknown>>> {
  await flushJournal()
  const content = await readFile(path.join(root, 'memory/journal.jsonl'), 'utf8')
  return content
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((event) => event.kind === 'hook')
}

describe('executeHooks', () => {
  test('passes the documented JSON payload on stdin and event in the environment', async () => {
    const registry = new HookRegistry()
    const payloadPath = path.join(root, 'payload.json')
    const eventPath = path.join(root, 'event.txt')
    registry.register({
      event: 'post_tool_use',
      handler: {
        type: 'shell',
        command: `cat > '${payloadPath}'; printf %s "$OCTONOESIS_HOOK_EVENT" > '${eventPath}'`,
      },
    })

    const summary = await executeHooks(
      registry,
      {
        event: 'post_tool_use',
        tool: 'Read',
        input: { path: 'package.json' },
        outcome: { ok: true },
        sessionId: 'session-1',
      },
      { repoRoot: root },
    )

    expect(summary.denied).toBe(false)
    expect(JSON.parse(await readFile(payloadPath, 'utf8'))).toEqual({
      event: 'post_tool_use',
      tool: 'Read',
      input: { path: 'package.json' },
      outcome: { ok: true },
      sessionId: 'session-1',
    })
    expect(await readFile(eventPath, 'utf8')).toBe('post_tool_use')
    const events = await hookJournal()
    expect(events.length).toBe(1)
    expect(events[0]?.hook_event).toBe('post_tool_use')
    expect(events[0]?.hook_type).toBe('shell')
    expect(events[0]?.outcome).toBe('success')
    expect(events[0]?.schema_version).toBe(2)
  })

  test('treats pre-tool exit 2 as a denial with stderr', async () => {
    const registry = new HookRegistry()
    registry.register({
      event: 'pre_tool_use',
      toolPattern: 'Bash',
      handler: { type: 'shell', command: 'echo blocked-by-policy >&2; exit 2' },
    })
    const summary = await executeHooks(
      registry,
      { event: 'pre_tool_use', tool: 'Bash', input: { command: 'touch forbidden' } },
      { repoRoot: root },
    )
    expect(summary.denied).toBe(true)
    expect(summary.reason).toContain('blocked-by-policy')
    expect((await hookJournal())[0]?.outcome).toBe('failure')
  })

  test('contains other non-zero exits and continues to later handlers', async () => {
    const registry = new HookRegistry()
    let functionCalls = 0
    registry.register({
      event: 'pre_tool_use',
      handler: { type: 'shell', command: 'exit 7' },
    })
    registry.register({
      event: 'pre_tool_use',
      handler: {
        type: 'function',
        fn: async () => {
          functionCalls++
          return undefined
        },
      },
    })
    const summary = await executeHooks(
      registry,
      { event: 'pre_tool_use', tool: 'Read' },
      { repoRoot: root },
    )
    expect(summary.denied).toBe(false)
    expect(functionCalls).toBe(1)
    expect((await hookJournal()).map((event) => event.outcome)).toEqual(['failure', 'success'])
  })

  test('kills a hung shell hook at the configured cap and continues', async () => {
    const registry = new HookRegistry()
    let continued = false
    registry.register({ event: 'stop', handler: { type: 'shell', command: 'sleep 30' } })
    registry.register({
      event: 'stop',
      handler: {
        type: 'function',
        fn: async () => {
          continued = true
          return undefined
        },
      },
    })
    const started = performance.now()
    const summary = await executeHooks(
      registry,
      { event: 'stop' },
      { repoRoot: root },
      { timeoutMs: 50, termGraceMs: 20 },
    )
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(summary.denied).toBe(false)
    expect(continued).toBe(true)
    expect((await hookJournal()).map((event) => event.outcome)).toEqual(['timeout', 'success'])
  })

  test('aborts a timed-out function handler so built-in work cannot continue in the background', async () => {
    const registry = new HookRegistry()
    let observedAbort = false
    registry.register({
      event: 'stop',
      handler: {
        type: 'function',
        fn: async ({ abortSignal }) => {
          await new Promise<void>((resolve) => {
            abortSignal?.addEventListener(
              'abort',
              () => {
                observedAbort = true
                resolve()
              },
              { once: true },
            )
          })
          return undefined
        },
      },
    })
    const summary = await executeHooks(
      registry,
      { event: 'stop' },
      { repoRoot: root },
      { timeoutMs: 30 },
    )
    expect(summary.results[0]?.outcome).toBe('timeout')
    expect(observedAbort).toBe(true)
  })

  test('uses a matcher timeout override instead of the caller default for function hooks', async () => {
    const registry = new HookRegistry()
    let completed = false
    registry.register({
      event: 'stop',
      timeoutMs: 500,
      handler: {
        type: 'function',
        fn: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200))
          completed = true
          return undefined
        },
      },
    })
    const started = performance.now()
    const summary = await executeHooks(
      registry,
      { event: 'stop' },
      { repoRoot: root },
      { timeoutMs: 50 },
    )
    const duration = performance.now() - started

    expect(summary.results[0]?.outcome).toBe('success')
    expect(completed).toBe(true)
    expect(duration).toBeGreaterThan(175)
    expect(duration).toBeLessThan(450)
  })
})
