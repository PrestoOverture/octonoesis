import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { clearConfigCacheForTests, getConfigTrustWarning } from '../../src/config/load'
import { parseConfig } from '../../src/config/schema'
import { flushJournal } from '../../src/memory/journal'
import {
  clearAllowlist,
  registerPromptHandler,
  unregisterPromptHandler,
} from '../../src/permissions/confirm'
import { setProvider } from '../../src/providers'
import type {
  CanonicalMessage,
  CanonicalTool,
  LLMProvider,
  StreamEvent,
} from '../../src/providers/types'
import { type QueryResult, query } from '../../src/query/engine'
import { getAllTools } from '../../src/tools/registry'

const fixtureServer = path.resolve('test/fixtures/mcp/server.ts')
const execFileAsync = promisify(execFile)
const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
const originalDisableCompact = process.env.OCTONOESIS_DISABLE_COMPACT

class McpRoundTripProvider implements LLMProvider {
  readonly name = 'anthropic' as const
  calls = 0
  firstTools: CanonicalTool[] = []
  toolResult = ''

  async *createMessageStream(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
  ): AsyncIterable<StreamEvent> {
    this.calls++
    if (this.calls === 1) {
      this.firstTools = tools
      yield {
        type: 'tool_use',
        id: 'mcp-call-1',
        name: 'mcp__fixture__echo',
        input: { text: 'kraken' },
      }
    } else {
      const result = messages.find(
        (message) => message.role === 'tool' && message.tool_use_id === 'mcp-call-1',
      )
      this.toolResult = JSON.stringify(result)
      yield { type: 'text_delta', text: 'MCP completed.' }
    }
    yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
  }
}

class FinalOnlyProvider implements LLMProvider {
  readonly name = 'anthropic' as const
  firstTools: CanonicalTool[] = []

  async *createMessageStream(
    _messages: CanonicalMessage[],
    tools: CanonicalTool[],
  ): AsyncIterable<StreamEvent> {
    this.firstTools = tools
    yield { type: 'text_delta', text: 'Session continued.' }
    yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
  }
}

async function collect(
  generator: AsyncGenerator<unknown, QueryResult, undefined>,
): Promise<QueryResult> {
  let step = await generator.next()
  while (!step.done) step = await generator.next()
  return step.value
}

async function waitForExit(pid: number): Promise<boolean> {
  for (let index = 0; index < 40; index++) {
    try {
      process.kill(pid, 0)
      await new Promise((resolve) => setTimeout(resolve, 25))
    } catch {
      return true
    }
  }
  return false
}

let root = ''
let memoryDir = ''

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-mcp-root-'))
  memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-mcp-memory-'))
  process.env.OCTONOESIS_MEMORY_DIR = memoryDir
  process.env.OCTONOESIS_DISABLE_COMPACT = '1'
  clearConfigCacheForTests()
  clearAllowlist()
  unregisterPromptHandler()
})

afterEach(async () => {
  setProvider(null)
  unregisterPromptHandler()
  clearAllowlist()
  clearConfigCacheForTests()
  await flushJournal()
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(memoryDir, { recursive: true, force: true })
  if (originalMemoryDir === undefined) Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  else process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
  if (originalDisableCompact === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_COMPACT')
  } else process.env.OCTONOESIS_DISABLE_COMPACT = originalDisableCompact
})

describe('MCP stdio integration', () => {
  it('discovers a real server tool, prompts, round-trips, journals, and closes the child', async () => {
    const marker = path.join(root, 'pids.txt')
    const config = parseConfig({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fixtureServer],
          env: { MCP_FIXTURE_MARKER: marker },
          timeout: 3000,
        },
      },
    })
    const provider = new McpRoundTripProvider()
    setProvider(provider)
    const prompted: string[] = []
    registerPromptHandler(async (name) => {
      prompted.push(name)
      return 'allow_once'
    })

    const result = await collect(
      query('Use the fixture MCP tool', { repoRoot: root, sessionId: 'mcp-round-trip', config }),
    )

    expect(result.exit_reason).toBe('completed')
    const advertised = provider.firstTools.find((tool) => tool.name === 'mcp__fixture__echo')
    expect(advertised?.description).toContain('fixture MCP server')
    expect(advertised?.inputSchema.type).toBe('object')
    expect(advertised?.inputSchema.properties).toEqual({ text: { type: 'string' } })
    expect(advertised?.inputSchema.required).toEqual(['text'])
    expect(provider.toolResult).toContain('fixture:kraken')
    expect(prompted).toEqual(['mcp__fixture__echo'])
    expect(getAllTools().some((tool) => tool.name === 'mcp__fixture__echo')).toBe(false)

    const journal = (await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(
      journal.some(
        (row) =>
          row.kind === 'tool' && row.tool === 'mcp__fixture__echo' && row.outcome === 'success',
      ),
    ).toBe(true)
    expect(
      journal.some(
        (row) =>
          row.kind === 'permission' &&
          typeof row.key === 'string' &&
          row.key.startsWith('mcp__fixture__echo:'),
      ),
    ).toBe(true)

    const pid = Number((await fs.readFile(marker, 'utf8')).trim())
    expect(Number.isInteger(pid)).toBe(true)
    expect(await waitForExit(pid)).toBe(true)
  })

  it('skips a broken server quickly and lets the session use its normal tool list', async () => {
    const config = parseConfig({
      mcpServers: {
        broken: { command: path.join(root, 'does-not-exist'), timeout: 100 },
      },
    })
    const provider = new FinalOnlyProvider()
    setProvider(provider)
    const started = performance.now()

    const result = await collect(
      query('Continue despite MCP failure', { repoRoot: root, sessionId: 'mcp-broken', config }),
    )

    expect(result.exit_reason).toBe('completed')
    expect(performance.now() - started).toBeLessThan(1500)
    expect(provider.firstTools.some((tool) => tool.name === 'Read')).toBe(true)
    expect(provider.firstTools.some((tool) => tool.name.startsWith('mcp__broken__'))).toBe(false)
  })

  it('does not launch tracked-untrusted MCP config and trust restores launch', async () => {
    await execFileAsync('git', ['init', '-q', root])
    await fs.mkdir(path.join(root, '.octonoesis'), { recursive: true })
    const marker = path.join(root, 'launches.txt')
    const rawConfig = {
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fixtureServer],
          env: { MCP_FIXTURE_MARKER: marker },
          timeout: 3000,
        },
      },
    }
    await fs.writeFile(path.join(root, '.octonoesis', 'config.json'), JSON.stringify(rawConfig))
    await execFileAsync('git', ['-C', root, 'add', '.octonoesis/config.json'])

    const untrusted = parseConfig(rawConfig)
    const warning = await getConfigTrustWarning(root, untrusted)
    expect(warning).toContain('MCP servers')
    const skippedProvider = new FinalOnlyProvider()
    setProvider(skippedProvider)
    expect(
      (
        await collect(
          query('Do not launch', { repoRoot: root, sessionId: 'mcp-untrusted', config: untrusted }),
        )
      ).exit_reason,
    ).toBe('completed')
    expect(skippedProvider.firstTools.some((tool) => tool.name.startsWith('mcp__'))).toBe(false)
    await expect(fs.access(marker)).rejects.toThrow()

    const trusted = parseConfig({ ...rawConfig, trustTrackedConfig: true })
    const trustedProvider = new FinalOnlyProvider()
    setProvider(trustedProvider)
    expect(
      (
        await collect(
          query('Launch trusted MCP', {
            repoRoot: root,
            sessionId: 'mcp-trusted',
            config: trusted,
          }),
        )
      ).exit_reason,
    ).toBe('completed')
    expect(trustedProvider.firstTools.some((tool) => tool.name === 'mcp__fixture__echo')).toBe(true)
    const pid = Number((await fs.readFile(marker, 'utf8')).trim())
    expect(await waitForExit(pid)).toBe(true)
  })
})
