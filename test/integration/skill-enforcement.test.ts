// biome-ignore lint/suspicious/noExplicitAny: Bun globals are provided by the test runtime.
declare const Bun: any

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { forkAgent } from '../../src/providers/fork'
import type { CanonicalTool } from '../../src/providers/types'

const originalMain = Bun.main
const originalCwd = process.cwd()
const originalMock = process.env.OCTONOESIS_FORK_MOCK
const roots: string[] = []

afterEach(async () => {
  Bun.main = originalMain
  process.chdir(originalCwd)
  if (originalMock === undefined) Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_MOCK')
  else process.env.OCTONOESIS_FORK_MOCK = originalMock
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const schema = { type: 'object', additionalProperties: true }

async function refused(requestedName: string, preparedTools: CanonicalTool[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'skill-enforce-'))
  roots.push(root)
  process.chdir(root)
  Bun.main = path.join(originalCwd, 'src/cli.tsx')
  process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({
    scriptedEvents: [
      [
        { type: 'tool_use', id: 'smuggled', name: requestedName, input: {} },
        { type: 'message_end', usage: { input_tokens: 0, output_tokens: 0 } },
      ],
      [
        { type: 'text_delta', text: '{{tool_is_error}} {{tool_result}}' },
        { type: 'message_end', usage: { input_tokens: 0, output_tokens: 0 } },
      ],
    ],
  })
  const result = await forkAgent({
    forkPurpose: 'skill',
    systemPrompt: 'stable',
    messages: [{ role: 'user', content: 'attempt tool' }],
    tools: preparedTools,
    maxTurns: 2,
  })
  expect(await Bun.file(path.join(root, '.octonoesis')).exists()).toBe(false)
  return result.text
}

describe('real skill child enforcement', () => {
  test('refuses a safe tool absent from prepared.tools with is_error', async () => {
    expect(
      await refused('Read', [
        { name: 'Glob', description: 'allowed other tool', inputSchema: schema },
      ]),
    ).toContain('true Tool Read is not available')
  })

  test('refuses Write even when smuggled into prepared.tools', async () => {
    expect(
      await refused('Write', [{ name: 'Write', description: 'smuggled', inputSchema: schema }]),
    ).toContain('true Tool Write is not available')
  })

  test('refuses Bash even when smuggled into prepared.tools', async () => {
    expect(
      await refused('Bash', [{ name: 'Bash', description: 'smuggled', inputSchema: schema }]),
    ).toContain('true Tool Bash is not available')
  })
})
