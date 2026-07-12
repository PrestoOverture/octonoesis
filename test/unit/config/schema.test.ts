import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ConfigValidationError,
  DEFAULT_CONFIG,
  type OctonoesisConfig,
  octonoesisConfigSchema,
  parseConfig,
} from '../../../src/config/schema'
import type { SandboxConfig } from '../../../src/query/types'

const assertConfig = (config: OctonoesisConfig): OctonoesisConfig => config

function expectConfigError(raw: unknown, path: string, problem?: string): void {
  let caught: unknown
  try {
    parseConfig(raw)
  } catch (error) {
    caught = error
  }

  expect(caught instanceof ConfigValidationError).toBe(true)
  if (caught instanceof ConfigValidationError) {
    expect(caught.name).toBe('ConfigValidationError')
    expect(caught.message).toContain(`${path}:`)
    if (problem) {
      expect(caught.message).toContain(`${path}: ${problem}`)
    }
  }
}

describe('Octonoesis config schema', () => {
  it('applies the complete defaults to empty and undefined input', () => {
    const expected: OctonoesisConfig = {
      maxTurns: 50,
      sandbox: { enabled: false },
      mcpServers: {},
      hooks: [],
      permissions: { allowPatterns: [], denyPatterns: [] },
      projectInstructions: 'on',
      compaction: { cooldownTurns: 0, minShrinkPercent: 0 },
      trustTrackedConfig: false,
    }

    expect(parseConfig({})).toEqual(expected)
    expect(parseConfig(undefined)).toEqual(expected)
    expect(DEFAULT_CONFIG).toEqual(expected)
    expect(assertConfig(octonoesisConfigSchema.parse(DEFAULT_CONFIG))).toEqual(DEFAULT_CONFIG)
  })

  it('rejects unknown top-level keys with their exact path', () => {
    expectConfigError({ sanbox: { enabled: false } }, 'sanbox')
  })

  it('rejects unknown keys at every nested object boundary', () => {
    const cases: Array<[unknown, string]> = [
      [{ sandbox: { enabled: false, typo: true } }, 'sandbox.typo'],
      [
        { sandbox: { enabled: false, filesystem: { allowWrite: [], typo: true } } },
        'sandbox.filesystem.typo',
      ],
      [
        { sandbox: { enabled: false, network: { allowedDomains: [], typo: true } } },
        'sandbox.network.typo',
      ],
      [
        { mcpServers: { sqlite: { command: 'sqlite-server', typo: true } } },
        'mcpServers.sqlite.typo',
      ],
      [{ hooks: [{ event: 'stop', command: 'echo done', typo: true }] }, 'hooks.0.typo'],
      [{ permissions: { allowPatterns: [], denyPatterns: [], typo: true } }, 'permissions.typo'],
    ]

    for (const [raw, path] of cases) {
      expectConfigError(raw, path)
    }
  })

  it('rejects non-positive, fractional, and wrong-typed maxTurns values', () => {
    for (const maxTurns of [0, -1, 1.5, '50']) {
      expectConfigError({ maxTurns }, 'maxTurns', 'expected positive integer')
    }
  })

  it('rejects MCP servers with missing or empty commands', () => {
    expectConfigError({ mcpServers: { sqlite: {} } }, 'mcpServers.sqlite.command')
    expectConfigError({ mcpServers: { sqlite: { command: '' } } }, 'mcpServers.sqlite.command')
  })

  it('rejects invalid hook events', () => {
    expectConfigError(
      { hooks: [{ event: 'before_everything', command: 'echo invalid' }] },
      'hooks.0.event',
    )
  })

  it('rejects hooks missing their command', () => {
    expectConfigError({ hooks: [{ event: 'stop' }] }, 'hooks.0.command')
  })

  it('rejects wrong-typed permissions', () => {
    expectConfigError({ permissions: 'allow-all' }, 'permissions')
    expectConfigError(
      { permissions: { allowPatterns: 'Read', denyPatterns: [] } },
      'permissions.allowPatterns',
    )
  })

  it('validates the Phase 33 settings and permission pattern grammar', () => {
    const parsed = parseConfig({
      projectInstructions: 'off',
      compaction: { cooldownTurns: 3, minShrinkPercent: 25 },
      trustTrackedConfig: true,
      permissions: {
        allowPatterns: ['Edit', 'Bash(git status*)'],
        denyPatterns: ['Write'],
      },
    })
    expect(parsed.projectInstructions).toBe('off')
    expect(parsed.compaction).toEqual({ cooldownTurns: 3, minShrinkPercent: 25 })
    expect(parsed.trustTrackedConfig).toBe(true)

    for (const [raw, path] of [
      [{ projectInstructions: 'sometimes' }, 'projectInstructions'],
      [{ compaction: { cooldownTurns: -1 } }, 'compaction.cooldownTurns'],
      [{ compaction: { minShrinkPercent: 101 } }, 'compaction.minShrinkPercent'],
      [{ permissions: { allowPatterns: ['Bash(git status)'] } }, 'permissions.allowPatterns.0'],
      [{ permissions: { allowPatterns: ['Bash(git * status*)'] } }, 'permissions.allowPatterns.0'],
      [{ permissions: { denyPatterns: ['Edit(*)'] } }, 'permissions.denyPatterns.0'],
    ] as const) {
      expectConfigError(raw, path)
    }
  })

  it('reports every validation issue in a single error', () => {
    let caught: unknown
    try {
      parseConfig({ maxTurns: 0, sanbox: {} })
    } catch (error) {
      caught = error
    }

    expect(caught instanceof ConfigValidationError).toBe(true)
    if (caught instanceof ConfigValidationError) {
      expect(caught.message).toContain('maxTurns: expected positive integer')
      expect(caught.message).toContain('sanbox: unrecognized key')
    }
  })

  it('accepts exactly the six configured hook events and rejects object-shaped hooks', () => {
    const events = [
      'pre_tool_use',
      'post_tool_use',
      'stop',
      'session_start',
      'session_end',
      'compact',
    ] as const
    const parsed = parseConfig({
      hooks: events.map((event) => ({ event, command: `echo ${event}` })),
    })

    expect(parsed.hooks.map((hook) => hook.event)).toEqual(events)
    expectConfigError({ hooks: {} }, 'hooks')
  })

  it('applies positive-integer validation to MCP timeouts', () => {
    for (const timeout of [0, -1, 1.5, '5000']) {
      expectConfigError(
        { mcpServers: { sqlite: { command: 'sqlite-server', timeout } } },
        'mcpServers.sqlite.timeout',
        'expected positive integer',
      )
    }
  })

  it('parses the fully populated config fixture', async () => {
    const fixturePath = join(import.meta.dir, '../../fixtures/config/valid.json')
    const raw = JSON.parse(await readFile(fixturePath, 'utf8'))
    const parsed = parseConfig(raw)
    const sandboxConfig: SandboxConfig = parsed.sandbox

    expect(parsed.model).toBe('claude-sonnet-4-6')
    expect(parsed.maxTurns).toBe(75)
    expect(parsed.mcpServers.sqlite).toEqual({
      command: 'bunx',
      args: ['-y', '@modelcontextprotocol/server-sqlite', './data/app.db'],
      env: { SQLITE_BUSY_TIMEOUT: '5000' },
      timeout: 7500,
    })
    expect(parsed.hooks[0]?.event).toBe('pre_tool_use')
    expect(sandboxConfig.network?.allowedDomains).toEqual(['registry.npmjs.org'])
  })

  it('applies omitted MCP server and nested section defaults', () => {
    const parsed = parseConfig({
      sandbox: {},
      mcpServers: { sqlite: { command: 'sqlite-server' } },
      permissions: {},
    })

    expect(parsed.sandbox).toEqual({ enabled: false })
    expect(parsed.mcpServers.sqlite).toEqual({
      command: 'sqlite-server',
      args: [],
      timeout: 5000,
    })
    expect(parsed.permissions).toEqual({ allowPatterns: [], denyPatterns: [] })
  })
})
