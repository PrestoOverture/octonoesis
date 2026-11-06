// biome-ignore lint/suspicious/noExplicitAny: Bun subprocess handles are runtime-provided.
declare const Bun: any

import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { HostCommand, HostMessage } from '../../src/host/protocol'

const usageSchema = z.object({ input_tokens: z.number(), output_tokens: z.number() })
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_delta'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({
    type: z.literal('message_end'),
    usage: usageSchema,
    stopReason: z.enum(['end_turn', 'tool_use', 'max_tokens', 'other']),
  }),
  z.object({
    type: z.literal('tool_done'),
    id: z.string(),
    name: z.string(),
    status: z.enum(['done', 'error']),
    summary: z.string().optional(),
  }),
  z.object({
    type: z.literal('session_state'),
    priced: z.boolean(),
    sessionState: z.object({
      sessionId: z.string(),
      model: z.string(),
      startTime: z.number(),
      turns: z.number(),
      usage: usageSchema,
      costUsd: z.number(),
      contextUtilization: z.number(),
      compactCount: z.number(),
    }),
  }),
  z.object({
    type: z.literal('rule_recall'),
    trigger: z.enum(['session_start', 'failure']),
    rules: z.array(z.object({ id: z.string(), confidence: z.number() })),
  }),
  z.object({
    type: z.literal('rule_outcome'),
    id: z.string(),
    hit: z.boolean(),
    before: z.number(),
    after: z.number(),
  }),
  z.object({
    type: z.literal('rules_learned'),
    created: z.array(z.object({ id: z.string(), status: z.string() })),
    updated: z.number(),
  }),
  z.object({ type: z.literal('task_notice'), text: z.string() }),
  z.object({
    type: z.literal('compact'),
    preTokens: z.number(),
    postTokens: z.number(),
    durationMs: z.number(),
  }),
  z.object({ type: z.literal('stream_retry'), attempt: z.number(), reason: z.string() }),
])

// Validate every stdout line independently of the host's implementation.
const messageSchema = z.discriminatedUnion('type', [
  z.object({
    v: z.literal(1),
    type: z.literal('ready'),
    sessionId: z.string().min(1),
    model: z.string().min(1),
    repoRoot: z.string(),
    version: z.string(),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal('event'),
    event: eventSchema,
  }),
  z.object({
    v: z.literal(1),
    type: z.literal('permission_request'),
    requestId: z.string().min(1),
    toolName: z.string(),
    input: z.unknown(),
    preview: z.string().optional(),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal('turn_end'),
    exitReason: z.enum([
      'completed',
      'user_cancel',
      'fatal_error',
      'max_turns',
      'budget_exceeded',
      'prompt_too_long',
    ]),
    failure: z.string().optional(),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal('permission_mode'),
    mode: z.enum(['ask', 'accept-edits', 'bypass']),
  }),
  z.object({ v: z.literal(1), type: z.literal('error'), message: z.string() }),
  z.object({ v: z.literal(1), type: z.literal('fatal'), message: z.string() }),
])

async function launch(
  check: (host: {
    messages: HostMessage[]
    send: (command: HostCommand | string) => void
    next: (type: HostMessage['type'], after?: number) => Promise<HostMessage>
    child: ReturnType<typeof Bun.spawn>
    dir: string
    stderr: () => string
  }) => Promise<void>,
  missingKey = false,
  denyBash = false,
) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'octonoesis-host-')))
  await writeFile(join(dir, 'edit.txt'), 'keep\nold1\nold2\ntail\n')
  if (denyBash) {
    await mkdir(join(dir, '.octonoesis'))
    await writeFile(
      join(dir, '.octonoesis/config.json'),
      JSON.stringify({ permissions: { denyPatterns: ['Bash'] } }),
    )
  }
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      '--preload',
      resolve('test/fixtures/host/preload.ts'),
      resolve(process.env.HOST_TEST_ENTRY || 'src/host/main.ts'),
    ],
    cwd: dir,
    env: {
      ...process.env,
      OCTONOESIS_REPO_ROOT: dir,
      OCTONOESIS_MEMORY_DIR: dir,
      OCTONOESIS_DISABLE_MEMORY: '0',
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: missingKey ? '' : 'fake',
      ANTHROPIC_AUTH_TOKEN: '',
      OCTONOESIS_FORK_MOCK: JSON.stringify({ text: 'fork response' }),
      CI: 'true',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const messages: HostMessage[] = []
  let stderr = ''
  let parseError: unknown
  const drain = (async () => {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          const message = JSON.parse(line)
          messageSchema.parse(message)
          messages.push(message)
        } catch (error) {
          parseError = error
        }
        newline = buffer.indexOf('\n')
      }
      if (done) break
    }
    if (buffer) parseError = new Error(`Unterminated stdout: ${buffer}`)
  })()
  const errors = (async () => {
    const reader = child.stderr.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      stderr += decoder.decode(value, { stream: true })
    }
  })()
  const next = async (type: HostMessage['type'], after = 0) => {
    const start = performance.now()
    while (true) {
      if (parseError) throw parseError
      const message = messages.slice(after).find((message) => message.type === type)
      if (message) return message
      if (child.exitCode !== null || performance.now() - start > 3500)
        throw new Error(`Expected ${type}: ${JSON.stringify(messages)}\n${stderr}`)
      await Bun.sleep(5)
    }
  }
  try {
    if (!missingKey) {
      await next('ready')
      expect(messages[0]?.type).toBe('ready')
      await next('permission_mode')
      expect(messages[1]).toEqual({ v: 1, type: 'permission_mode', mode: 'ask' })
    }
    await check({
      child,
      messages,
      next,
      dir,
      stderr: () => stderr,
      send: (command) => {
        child.stdin.write(`${typeof command === 'string' ? command : JSON.stringify(command)}\n`)
        child.stdin.flush()
      },
    })
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
    await Promise.all([drain, errors])
    await rm(dir, { recursive: true, force: true })
  }
  if (parseError) throw parseError
}

test('host ready first, submit streams only protocol, context persists across submits', async () => {
  await launch(async ({ messages, send, next, stderr }) => {
    send({ v: 1, type: 'submit', text: 'hello' })
    expect(await next('turn_end')).toEqual({ v: 1, type: 'turn_end', exitReason: 'completed' })
    expect(messages.filter((message) => message.type === 'event').length).toBeGreaterThan(1)
    expect(
      messages
        .filter((message) => message.type === 'event' && message.event.type === 'text_delta')
        .map((message) =>
          message.type === 'event' && message.event.type === 'text_delta' ? message.event.text : '',
        )
        .join(''),
    ).toBe('hello world')
    expect(stderr()).toContain('HOST_TEST_DIAGNOSTIC')
    expect(stderr()).toContain('HOST_TEST_DIRECT_WRITE')
    const after = messages.length
    send({ v: 1, type: 'submit', text: 'context' })
    expect(await next('turn_end', after)).toEqual({
      v: 1,
      type: 'turn_end',
      exitReason: 'completed',
    })
    expect(JSON.stringify(messages.slice(after))).toContain('users=2')
    const forkStart = messages.length
    send({ v: 1, type: 'submit', text: 'fork' })
    expect(await next('turn_end', forkStart)).toEqual({
      v: 1,
      type: 'turn_end',
      exitReason: 'completed',
    })
    expect(JSON.stringify(messages.slice(forkStart))).toContain('fork response')
  })
})

for (const decision of ['allow_once', 'deny'] as const) {
  test(`host permission ${decision} ${decision === 'deny' ? 'blocks' : 'runs'} the real Write tool`, async () => {
    await launch(async ({ send, next, dir, messages }) => {
      send({ v: 1, type: 'submit', text: 'write' })
      const request = await next('permission_request')
      if (request.type !== 'permission_request') throw new Error('Missing permission request')
      expect(request.toolName).toBe('Write')
      send({ v: 1, type: 'permission_reply', requestId: request.requestId, decision })
      expect(await next('turn_end')).toEqual({ v: 1, type: 'turn_end', exitReason: 'completed' })
      if (decision === 'allow_once')
        expect(await readFile(join(dir, 'approved.txt'), 'utf8')).toBe('approved\n')
      else await expect(readFile(join(dir, 'approved.txt'), 'utf8')).rejects.toThrow()
      expect(
        messages.some(
          (message) =>
            message.type === 'event' &&
            message.event.type === 'tool_done' &&
            message.event.status === (decision === 'deny' ? 'error' : 'done'),
        ),
      ).toBe(true)
    })
  })
}

test('host cancel finishes user_cancel and next submit completes; busy submit errors', async () => {
  await launch(async ({ send, next, messages }) => {
    send({ v: 1, type: 'submit', text: 'wait' })
    await next('event')
    send({ v: 1, type: 'submit', text: 'overlap' })
    const error = await next('error')
    if (error.type !== 'error') throw new Error('Missing busy error')
    expect(error.message).toContain('already running')
    send({ v: 1, type: 'cancel' })
    expect(await next('turn_end')).toEqual({ v: 1, type: 'turn_end', exitReason: 'user_cancel' })
    const after = messages.length
    send({ v: 1, type: 'submit', text: 'hello' })
    expect(await next('turn_end', after)).toEqual({
      v: 1,
      type: 'turn_end',
      exitReason: 'completed',
    })
  })
})

for (const method of ['SIGTERM', 'shutdown'] as const) {
  test(`host ${method} exits 0 within 3 seconds after real session-end cleanup`, async () => {
    await launch(async ({ child, send, next, dir }) => {
      send({ v: 1, type: 'submit', text: 'wait' })
      await next('event')
      const start = performance.now()
      if (method === 'SIGTERM') child.kill('SIGTERM')
      else send({ v: 1, type: 'shutdown' })
      const timeout = setTimeout(() => child.kill('SIGKILL'), 2950)
      try {
        expect(await child.exited).toBe(0)
      } finally {
        clearTimeout(timeout)
      }
      expect(performance.now() - start).toBeLessThan(3000)
      const journal = (await readFile(join(dir, 'journal.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(
        journal.some((record) => record.kind === 'session' && record.exit_reason === 'user_cancel'),
      ).toBe(true)
      expect(
        journal.some(
          (record) =>
            record.kind === 'hook' &&
            record.hook_event === 'session_end' &&
            record.outcome === 'success',
        ),
      ).toBe(true)
      // Query finalization saves the session before host cleanup can exit.
      const files = await import('node:fs/promises').then((fs) => fs.readdir(join(dir, 'sessions')))
      expect(files.some((file) => file.endsWith('.json'))).toBe(true)
    })
  })
}

test('host malformed, unknown and wrong-version commands error, then host survives', async () => {
  await launch(async ({ send, next, messages }) => {
    for (const line of [
      '{broken',
      '{"v":1,"type":"unknown"}',
      '{"v":2,"type":"cancel"}',
      '{"v":1,"type":"submit","text":0}',
    ]) {
      const after = messages.length
      send(line)
      await next('error', after)
    }
    send({ v: 1, type: 'submit', text: 'hello' })
    expect(await next('turn_end')).toEqual({ v: 1, type: 'turn_end', exitReason: 'completed' })
  })
})

test('host startup failure is fatal and exits nonzero', async () => {
  await launch(async ({ next, child, messages }) => {
    await next('fatal')
    expect(messages[0]?.type).toBe('fatal')
    expect(await child.exited).not.toBe(0)
  }, true)
})

for (const mode of ['bypass', 'accept-edits'] as const) {
  test(`host ${mode} auto-allows Edit and ${mode === 'bypass' ? 'auto-allows' : 'prompts for'} Bash`, async () => {
    await launch(async ({ send, next, messages, dir }) => {
      const after = messages.length
      send({ v: 1, type: 'set_permission_mode', mode })
      expect(await next('permission_mode', after)).toEqual({ v: 1, type: 'permission_mode', mode })
      send({ v: 1, type: 'submit', text: 'edit-bash' })
      if (mode === 'accept-edits') {
        const request = await next('permission_request', after)
        if (request.type !== 'permission_request') throw new Error('Missing Bash prompt')
        expect(request.toolName).toBe('Bash')
        // Edit already ran before Bash's permission check.
        expect(await readFile(join(dir, 'edit.txt'), 'utf8')).toBe('keep\nnew\ntail\n')
        send({
          v: 1,
          type: 'permission_reply',
          requestId: request.requestId,
          decision: 'allow_once',
        })
      }
      expect(await next('turn_end', after)).toEqual({
        v: 1,
        type: 'turn_end',
        exitReason: 'completed',
      })
      expect(await readFile(join(dir, 'bash-ran.txt'), 'utf8')).toBe('ran')
      expect(await readFile(join(dir, 'edit.txt'), 'utf8')).toBe('keep\nnew\ntail\n')
      expect(
        messages.slice(after).filter((message) => message.type === 'permission_request').length,
      ).toBe(mode === 'bypass' ? 0 : 1)
      const edit = messages.find(
        (message) =>
          message.type === 'event' &&
          message.event.type === 'tool_done' &&
          message.event.name === 'Edit',
      )
      if (edit?.type !== 'event' || edit.event.type !== 'tool_done')
        throw new Error('Missing Edit completion')
      expect(edit.event.status).toBe('done')
      expect(edit.event.summary).toBe('+1 −2 lines')
    })
  })
}

test('host invalid permission mode errors and keeps Ask; switching leaves pending prompt unresolved and affects next check', async () => {
  await launch(async ({ send, next, messages, dir }) => {
    const after = messages.length
    send('{"v":1,"type":"set_permission_mode","mode":"invalid"}')
    await next('error', after)
    send({ v: 1, type: 'submit', text: 'edit-bash' })
    const request = await next('permission_request', after)
    if (request.type !== 'permission_request') throw new Error('Missing Edit prompt')
    expect(request.toolName).toBe('Edit')
    const switching = messages.length
    send({ v: 1, type: 'set_permission_mode', mode: 'bypass' })
    await next('permission_mode', switching)
    // Round-trip a subsequent command as a barrier; the pending Edit still has not run.
    send('{"v":1,"type":"unknown"}')
    await next('error', switching)
    expect(await readFile(join(dir, 'edit.txt'), 'utf8')).toBe('keep\nold1\nold2\ntail\n')
    expect(messages.some((message) => message.type === 'turn_end')).toBe(false)
    send({ v: 1, type: 'permission_reply', requestId: request.requestId, decision: 'deny' })
    await next('turn_end', after)
    expect(await readFile(join(dir, 'edit.txt'), 'utf8')).toBe('keep\nold1\nold2\ntail\n')
    expect(await readFile(join(dir, 'bash-ran.txt'), 'utf8')).toBe('ran')
    expect(messages.filter((message) => message.type === 'permission_request').length).toBe(1)
  })
})

test('host Bypass still honors config denyPatterns', async () => {
  await launch(
    async ({ send, next, dir, messages }) => {
      const after = messages.length
      send({ v: 1, type: 'set_permission_mode', mode: 'bypass' })
      await next('permission_mode', after)
      send({ v: 1, type: 'submit', text: 'edit-bash' })
      await next('turn_end', after)
      expect(await readFile(join(dir, 'edit.txt'), 'utf8')).toBe('keep\nnew\ntail\n')
      await expect(readFile(join(dir, 'bash-ran.txt'), 'utf8')).rejects.toThrow()
      expect(messages.some((message) => message.type === 'permission_request')).toBe(false)
      expect(
        messages.some(
          (message) =>
            message.type === 'event' &&
            message.event.type === 'tool_done' &&
            message.event.name === 'Bash' &&
            message.event.status === 'error',
        ),
      ).toBe(true)
    },
    false,
    true,
  )
})
