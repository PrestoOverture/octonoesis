import { expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { flushJournal } from '../../../src/memory/journal'
import { registerPromptHandler, unregisterPromptHandler } from '../../../src/permissions/confirm'
import { setProvider } from '../../../src/providers'
import { type StreamEvent, query } from '../../../src/query/engine'
import type { QueryLoopContext } from '../../../src/query/types'
import { bashTool } from '../../../src/tools/Bash'
import { readTool } from '../../../src/tools/Read'
import { registerTool } from '../../../src/tools/registry'
import { restoreEnv } from '../../helpers/env'

test('Read and failing Bash preserve main canonical messages and journal tool events', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ui2-engine-')))
  const env = {
    OCTONOESIS_MEMORY_DIR: directory,
    OCTONOESIS_DISABLE_MEMORY: '1',
    OCTONOESIS_DISABLE_COMPACT: '1',
  }
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  registerTool(readTool)
  registerTool(bashTool)
  registerPromptHandler(async () => 'allow_once')
  await fs.writeFile(path.join(directory, 'x.ts'), 'first\nsecond\nthird')
  let turn = 0
  const calls = [
    { type: 'tool_use' as const, id: 'read', name: 'Read', input: { path: 'x.ts' } },
    { type: 'tool_use' as const, id: 'bash', name: 'Bash', input: { command: 'exit 1' } },
  ]
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      if (turn++ === 0) yield* calls
      else yield { type: 'text_delta', text: 'finished' }
      yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
    },
  })
  const ctx: QueryLoopContext = {
    repoRoot: directory,
    memoryDir: directory,
    messages: [],
    sessionId: 'ui2-invariance',
  }
  try {
    const events: StreamEvent[] = []
    for await (const event of query('inspect and fail', ctx)) events.push(event)
    await flushJournal()
    // These exact canonical bytes and tool-event fields are also verified against main.
    expect(JSON.stringify(ctx.messages?.filter((message) => message.role === 'tool'))).toBe(
      JSON.stringify([
        { role: 'tool', tool_use_id: 'read', content: '1\tfirst\n2\tsecond\n3\tthird' },
        { role: 'tool', tool_use_id: 'bash', content: '{"code":1,"stdout":"","stderr":""}' },
      ]),
    )
    const journal = (await fs.readFile(path.join(directory, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row.kind === 'tool')
    // Wall-clock timestamp and measured runtime vary; no other fields are dropped.
    const normalized = journal.map(({ ts, duration_ms, ...row }) => {
      expect(typeof ts).toBe('string')
      expect(typeof duration_ms).toBe('number')
      return row
    })
    expect(normalized).toEqual(
      calls.map((call) => ({
        schema_version: 1,
        session_id: 'ui2-invariance',
        kind: 'tool',
        tool: call.name,
        input_digest: crypto.createHash('sha256').update(JSON.stringify(call.input)).digest('hex'),
        outcome: 'success',
        error_class: null,
        ...(call.name === 'Read' ? { path: 'x.ts' } : { cmd: 'exit 1', exit_code: 1 }),
      })),
    )
    expect(events.filter((event) => event.type === 'tool_done')).toEqual([
      { type: 'tool_done', id: 'read', name: 'Read', status: 'done', summary: '3 lines' },
      { type: 'tool_done', id: 'bash', name: 'Bash', status: 'error', summary: 'exit 1' },
    ])
  } finally {
    unregisterPromptHandler()
    setProvider(null)
    await flushJournal()
    for (const [key, value] of Object.entries(saved)) restoreEnv(key, value)
    await fs.rm(directory, { recursive: true, force: true })
  }
})
