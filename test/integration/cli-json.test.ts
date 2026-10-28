import { expect, test } from 'bun:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  mockProvider,
  projectRoot,
  providerEnv,
  run,
  tempRoot,
  toolChunk,
} from '../helpers/headless'

const cli = path.join(projectRoot, 'src/cli.tsx')
const usage = { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }

for (const mode of ['bypass', 'accept-edits', 'ask'] as const) {
  test(`JSON one-shot: ${mode} permissions and exactly one result on stdout`, async () => {
    const root = await tempRoot()
    await writeFile(path.join(root, 'value.txt'), 'before')
    let observedResults: string[] = []
    const server = mockProvider((body) => {
      const messages = body.messages as Array<{ role: string; content: string }>
      observedResults = messages.filter((message) => message.role === 'tool').map((m) => m.content)
      if (observedResults.length === 0) {
        return [toolChunk('Read', { path: 'value.txt' }), usage]
      }
      if (observedResults.length === 1) {
        return [
          { choices: [{ index: 0, delta: { content: 'editing now' } }] },
          toolChunk('Edit', { path: 'value.txt', old_string: 'before', new_string: 'after' }),
          toolChunk('Write', { path: 'new.txt', content: 'created' }, 1),
          toolChunk('Bash', { command: 'printf approved > bash.txt' }, 2),
          toolChunk('Bash', { command: 'exit 1' }, 3),
          usage,
        ]
      }
      return [{ choices: [{ index: 0, delta: { content: '**finished**\n' } }] }, usage]
    })
    try {
      const result = await run(
        [
          process.execPath,
          '--no-env-file',
          cli,
          '--output-format',
          'json',
          ...(mode === 'ask' ? [] : ['--permission-mode', mode]),
          'fix the file',
        ],
        root,
        providerEnv(root, server.port),
        mode === 'ask' ? 'n\nn\nn\nn\n' : 'n\nn\n',
      )
      expect(result.code).toBe(0)
      const value = JSON.parse(result.stdout)
      expect(result.stdout).toBe(`${JSON.stringify(value)}\n`)
      expect(Object.keys(value).sort()).toEqual(
        [
          'exit_reason',
          'turns',
          'usage',
          'duration_ms',
          'tool_calls',
          'final_text',
          'session_id',
        ].sort(),
      )
      expect(value.exit_reason).toBe('completed')
      expect(value.turns).toBe(3)
      expect(value.usage).toEqual({ input_tokens: 33, output_tokens: 21 })
      expect(value.duration_ms).toBeGreaterThan(0)
      expect(value.session_id).toContain('-')
      expect(value.final_text).toBe('**finished**\n')
      expect(value.tool_calls).toEqual([
        { name: 'Read', ok: true },
        { name: 'Edit', ok: mode !== 'ask' },
        { name: 'Write', ok: mode !== 'ask' },
        { name: 'Bash', ok: mode === 'bypass' },
        { name: 'Bash', ok: false },
      ])
      expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe(
        mode === 'ask' ? 'before' : 'after',
      )
      if (mode === 'bypass') {
        expect(result.stderr).toContain('Warning:')
        expect(result.stderr).toContain('bypass')
        expect(result.stderr).not.toContain('[Permission Request]')
        expect(await readFile(path.join(root, 'bash.txt'), 'utf8')).toBe('approved')
      } else {
        expect(result.stderr).toContain('[Permission Request] Tool: Bash')
        expect(result.stderr).toContain('Allow execution?')
        expect(result.stderr.includes('[Permission Request] Tool: Edit')).toBe(mode === 'ask')
        expect(result.stderr.includes('[Permission Request] Tool: Write')).toBe(mode === 'ask')
        expect(observedResults[3]).toContain('denied')
      }
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
}

test('JSON reports provider failure as a result object', async () => {
  const root = await tempRoot()
  const server = mockProvider(() => [
    { error: { message: 'invalid model', type: 'invalid_request_error' } },
  ])
  try {
    const result = await run(
      [process.execPath, '--no-env-file', cli, '--output-format', 'json', 'hello'],
      root,
      providerEnv(root, server.port),
    )
    expect(result.code).toBe(1)
    const value = JSON.parse(result.stdout)
    expect(value.exit_reason).toBe('fatal_error')
    expect(value.final_text).toBe('')
    expect(value.tool_calls).toEqual([])
  } finally {
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
