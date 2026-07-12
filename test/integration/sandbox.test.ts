import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { flushJournal } from '../../src/memory/journal'
import {
  clearAllowlist,
  registerPromptHandler,
  unregisterPromptHandler,
} from '../../src/permissions/confirm'
import { setProvider } from '../../src/providers'
import type { LLMProvider, StreamEvent } from '../../src/providers/types'
import { runQuery } from '../../src/query'
import { resolveSandboxConfig } from '../../src/sandbox/manager'
import type { ResolvedSandboxConfig } from '../../src/sandbox/types'
import { activeSubprocesses, bashTool } from '../../src/tools/Bash'
import { runTool } from '../../src/tools/execute'
import { registerTool } from '../../src/tools/registry'

// biome-ignore lint/suspicious/noExplicitAny: Bun subprocess typing is not available in tsconfig
declare const Bun: any

const describeDarwin = (
  describe as typeof describe & { skipIf: (condition: boolean) => typeof describe }
).skipIf(process.platform !== 'darwin')

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function runUnsandboxed(command: string): Promise<{
  code: number
  stdout: string
  stderr: string
}> {
  const process = Bun.spawn({
    cmd: ['bash', '-c', command],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { code, stdout, stderr }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

describeDarwin('macOS sandbox escape policy', () => {
  let root: string
  let repoRoot: string
  let homeDir: string
  let tmpDir: string
  let sandbox: ResolvedSandboxConfig
  let originalMemoryDir: string | undefined
  let originalDisableMemory: string | undefined
  let originalDisableCompact: string | undefined

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'octonoesis-sandbox-integration-'))
    repoRoot = path.join(root, 'repo')
    homeDir = path.join(root, 'home')
    tmpDir = path.join(root, 'tmp')
    await Promise.all([
      mkdir(path.join(repoRoot, '.octonoesis'), { recursive: true }),
      mkdir(path.join(homeDir, '.ssh'), { recursive: true }),
      mkdir(tmpDir, { recursive: true }),
    ])
    await writeFile(path.join(homeDir, '.ssh', 'id_rsa'), 'sandbox-canary-secret', 'utf8')
    originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
    originalDisableMemory = process.env.OCTONOESIS_DISABLE_MEMORY
    originalDisableCompact = process.env.OCTONOESIS_DISABLE_COMPACT
    process.env.OCTONOESIS_MEMORY_DIR = path.join(root, 'memory')
    process.env.OCTONOESIS_DISABLE_MEMORY = '1'
    process.env.OCTONOESIS_DISABLE_COMPACT = '1'
    sandbox = resolveSandboxConfig({
      repoRoot,
      cliEnabled: true,
      environment: { homeDir, tmpDir },
    })
  })

  afterEach(async () => {
    await flushJournal()
    await rm(root, { recursive: true, force: true })
    for (const [key, value] of Object.entries({
      OCTONOESIS_MEMORY_DIR: originalMemoryDir,
      OCTONOESIS_DISABLE_MEMORY: originalDisableMemory,
      OCTONOESIS_DISABLE_COMPACT: originalDisableCompact,
    })) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  })

  it('blocks a hardened HOME read while the identical unsandboxed probe succeeds', async () => {
    const command = `export HOME=${shellQuote(homeDir)}; cat "$HOME/.ssh/id_rsa"`
    const control = await runUnsandboxed(command)

    expect(control.code).toBe(0)
    expect(control.stdout).toContain('sandbox-canary-secret')

    const result = await bashTool.call({ command }, { repoRoot, sandbox })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const output = JSON.parse(result.value)
      expect(output.code).not.toBe(0)
      expect(output.stdout).not.toContain('sandbox-canary-secret')
      expect(output.stderr).toContain('[octonoesis-sandbox]')
    }
  })

  it('does not label an ordinary command failure as a sandbox denial', async () => {
    const result = await bashTool.call(
      { command: 'printf "ordinary failure" >&2; exit 7' },
      { repoRoot, sandbox },
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      const output = JSON.parse(result.value)
      expect(output.code).toBe(7)
      expect(output.stderr).toBe('ordinary failure')
      expect(output.stderr).not.toContain('[octonoesis-sandbox]')
    }
  })

  it('blocks writes outside the allowlist', async () => {
    const escapedPath = path.join(homeDir, 'escape.txt')
    const command = `export HOME=${shellQuote(homeDir)}; printf escaped > "$HOME/escape.txt"`
    const control = await runUnsandboxed(command)
    expect(control.code).toBe(0)
    expect(await readFile(escapedPath, 'utf8')).toBe('escaped')
    await rm(escapedPath, { force: true })

    const result = await bashTool.call({ command }, { repoRoot, sandbox })

    expect(result.ok).toBe(true)
    if (result.ok) {
      const output = JSON.parse(result.value)
      expect(output.code).not.toBe(0)
    }
    expect(await pathExists(escapedPath)).toBe(false)
  })

  it('keeps .octonoesis immutable while allowing ordinary repo writes', async () => {
    const journalPath = path.join(repoRoot, '.octonoesis', 'journal.jsonl')
    const normalPath = path.join(repoRoot, 'normal.txt')
    const originalJournal = '{"kind":"session"}\n'
    await writeFile(journalPath, originalJournal, 'utf8')
    const protectedCommand = `printf tampered >> ${shellQuote(journalPath)}`

    const control = await runUnsandboxed(protectedCommand)
    expect(control.code).toBe(0)
    expect(await readFile(journalPath, 'utf8')).toBe(`${originalJournal}tampered`)
    await writeFile(journalPath, originalJournal, 'utf8')

    const protectedResult = await bashTool.call(
      { command: protectedCommand },
      { repoRoot, sandbox },
    )
    expect(protectedResult.ok).toBe(true)
    if (protectedResult.ok) {
      expect(JSON.parse(protectedResult.value).code).not.toBe(0)
    }
    expect(await readFile(journalPath, 'utf8')).toBe(originalJournal)

    const normalResult = await bashTool.call(
      { command: `printf allowed > ${shellQuote(normalPath)}` },
      { repoRoot, sandbox },
    )
    expect(normalResult.ok).toBe(true)
    if (normalResult.ok) {
      expect(JSON.parse(normalResult.value).code).toBe(0)
    }
    expect(await readFile(normalPath, 'utf8')).toBe('allowed')
  })

  it('allows writes under the resolved TMPDIR', async () => {
    const tempOutput = path.join(tmpDir, 'sandbox-output.txt')
    const result = await bashTool.call(
      {
        command: `export TMPDIR=${shellQuote(tmpDir)}; printf temporary > "$TMPDIR/sandbox-output.txt"`,
      },
      { repoRoot, sandbox },
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(JSON.parse(result.value).code).toBe(0)
    }
    expect(await readFile(tempOutput, 'utf8')).toBe('temporary')
  })

  it('keeps the read denial in force for nested child shells', async () => {
    const nestedCommand = `HOME=${shellQuote(homeDir)} bash -c ${shellQuote('cat "$HOME/.ssh/id_rsa"')}`
    const control = await runUnsandboxed(nestedCommand)
    expect(control.code).toBe(0)
    expect(control.stdout).toContain('sandbox-canary-secret')

    const result = await bashTool.call({ command: nestedCommand }, { repoRoot, sandbox })

    expect(result.ok).toBe(true)
    if (result.ok) {
      const output = JSON.parse(result.value)
      expect(output.code).not.toBe(0)
      expect(output.stdout).not.toContain('sandbox-canary-secret')
    }
  })

  it('cannot bypass a denied read through a symlink in the writable repo', async () => {
    const canaryPath = path.join(homeDir, '.ssh', 'id_rsa')
    const symlinkPath = path.join(repoRoot, 'canary-link')
    await symlink(canaryPath, symlinkPath)
    const command = `cat ${shellQuote(symlinkPath)}`

    const control = await runUnsandboxed(command)
    expect(control.code).toBe(0)
    expect(control.stdout).toContain('sandbox-canary-secret')

    const result = await bashTool.call({ command }, { repoRoot, sandbox })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const output = JSON.parse(result.value)
      expect(output.code).not.toBe(0)
      expect(output.stdout).not.toContain('sandbox-canary-secret')
    }
  })

  it('denies network by default but permits it only for the explicit wildcard policy', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('ok'),
    })
    const probe = `bash -c ${shellQuote(`echo > /dev/tcp/127.0.0.1/${server.port}`)}`

    try {
      const control = await runUnsandboxed(probe)
      expect(control.code).toBe(0)

      const denied = await bashTool.call({ command: probe }, { repoRoot, sandbox })
      expect(denied.ok).toBe(true)
      if (denied.ok) {
        expect(JSON.parse(denied.value).code).not.toBe(0)
      }

      const networkAllowed = resolveSandboxConfig({
        repoRoot,
        config: { enabled: true, network: { allowedDomains: ['*'] } },
        environment: { homeDir, tmpDir },
      })
      const allowed = await bashTool.call({ command: probe }, { repoRoot, sandbox: networkAllowed })
      expect(allowed.ok).toBe(true)
      if (allowed.ok) {
        expect(JSON.parse(allowed.value).code).toBe(0)
      }
    } finally {
      server.stop(true)
    }
  })

  it('keeps confinement valid when repoRoot contains a double quote and a space', async () => {
    const quotedRepo = path.join(root, 'repo "quoted path')
    await mkdir(path.join(quotedRepo, '.octonoesis'), { recursive: true })
    const quotedSandbox = resolveSandboxConfig({
      repoRoot: quotedRepo,
      cliEnabled: true,
      environment: { homeDir, tmpDir },
    })

    const normalPath = path.join(quotedRepo, 'normal.txt')
    const allowed = await bashTool.call(
      { command: `printf quoted > ${shellQuote(normalPath)}` },
      { repoRoot: quotedRepo, sandbox: quotedSandbox },
    )
    expect(allowed.ok).toBe(true)
    if (allowed.ok) {
      expect(JSON.parse(allowed.value).code).toBe(0)
    }
    expect(await readFile(normalPath, 'utf8')).toBe('quoted')

    const canaryPath = path.join(homeDir, '.ssh', 'id_rsa')
    const deniedCommand = `cat ${shellQuote(canaryPath)}`
    const control = await runUnsandboxed(deniedCommand)
    expect(control.code).toBe(0)
    expect(control.stdout).toContain('sandbox-canary-secret')

    const denied = await bashTool.call(
      { command: deniedCommand },
      { repoRoot: quotedRepo, sandbox: quotedSandbox },
    )
    expect(denied.ok).toBe(true)
    if (denied.ok) {
      const output = JSON.parse(denied.value)
      expect(output.code).not.toBe(0)
      expect(output.stdout).not.toContain('sandbox-canary-secret')
    }
  })

  it('does not bypass sandboxing on the repeated verification-command path', async () => {
    const escapedPath = path.join(homeDir, 'verification-escape.txt')
    const command = `printf escaped 2>/dev/null > ${shellQuote(escapedPath)}`
    const control = await runUnsandboxed(command)
    expect(control.code).toBe(0)
    expect(await pathExists(escapedPath)).toBe(true)
    await rm(escapedPath, { force: true })

    registerTool(bashTool)
    clearAllowlist()
    registerPromptHandler(async () => 'allow_once')

    try {
      const result = await runTool(
        'Bash',
        { command },
        {
          repoRoot,
          sandbox,
          verificationCommand: command,
        },
      )

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(JSON.parse(result.value as string).code).not.toBe(0)
      }
      expect(await pathExists(escapedPath)).toBe(false)
    } finally {
      unregisterPromptHandler()
      clearAllowlist()
    }
  })

  it('threads sandboxing through one-shot runQuery without changing the Bash permission gate', async () => {
    const escapedPath = path.join(homeDir, 'one-shot-escape.txt')
    const command = `printf escaped 2>/dev/null > ${shellQuote(escapedPath)}`
    const control = await runUnsandboxed(command)
    expect(control.code).toBe(0)
    expect(await pathExists(escapedPath)).toBe(true)
    await rm(escapedPath, { force: true })

    let providerTurn = 0
    let promptCalled = false
    const provider: LLMProvider = {
      name: 'anthropic',
      async *createMessageStream(messages): AsyncIterable<StreamEvent> {
        providerTurn++
        if (providerTurn === 1) {
          yield { type: 'tool_use', id: 'sandbox-bash', name: 'Bash', input: { command } }
          yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
          return
        }

        const toolMessage = messages.at(-1)
        expect(toolMessage?.role).toBe('tool')
        if (toolMessage?.role === 'tool' && typeof toolMessage.content === 'string') {
          expect(JSON.parse(toolMessage.content).code).not.toBe(0)
          expect(toolMessage.content).not.toContain('escaped')
        }
        yield { type: 'text_delta', text: 'sandbox observed' }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    }
    const originalWrite = process.stdout.write
    const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
    const originalDisableMemory = process.env.OCTONOESIS_DISABLE_MEMORY
    const originalDisableCompact = process.env.OCTONOESIS_DISABLE_COMPACT
    process.env.OCTONOESIS_MEMORY_DIR = path.join(root, 'memory')
    process.env.OCTONOESIS_DISABLE_MEMORY = '1'
    process.env.OCTONOESIS_DISABLE_COMPACT = '1'
    process.stdout.write = () => true
    setProvider(provider)
    clearAllowlist()
    registerPromptHandler(async () => {
      promptCalled = true
      return 'allow_once'
    })

    try {
      await runQuery('exercise one-shot sandbox', sandbox)
      expect(promptCalled).toBe(true)
      expect(await pathExists(escapedPath)).toBe(false)
    } finally {
      process.stdout.write = originalWrite
      setProvider(null)
      unregisterPromptHandler()
      clearAllowlist()
      if (originalMemoryDir === undefined)
        Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
      else process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
      if (originalDisableMemory === undefined) {
        Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_MEMORY')
      } else process.env.OCTONOESIS_DISABLE_MEMORY = originalDisableMemory
      if (originalDisableCompact === undefined) {
        Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_COMPACT')
      } else process.env.OCTONOESIS_DISABLE_COMPACT = originalDisableCompact
    }
  })

  it('preserves process-group cancellation and active subprocess cleanup', async () => {
    const baseline = activeSubprocesses.size
    const controller = new AbortController()
    const pending = bashTool.call(
      { command: 'sleep 30 & wait' },
      { repoRoot, sandbox, abortSignal: controller.signal },
    )

    expect(activeSubprocesses.size).toBe(baseline + 1)
    controller.abort()
    const result = await pending

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('aborted')
    }
    expect(activeSubprocesses.size).toBe(baseline)
  })

  it('returns a tool error on sandbox-exec launch failure without an unsandboxed retry', async () => {
    const fallbackCanary = path.join(repoRoot, 'must-not-run.txt')
    const originalSpawn = Bun.spawn
    let spawnCalls = 0
    Bun.spawn = (options: { cmd?: string[] }) => {
      spawnCalls++
      if (options.cmd?.[0] === 'sandbox-exec') {
        throw new Error('simulated sandbox-exec launch failure')
      }
      return originalSpawn(options)
    }

    try {
      const result = await bashTool.call(
        { command: `printf fallback > ${shellQuote(fallbackCanary)}` },
        { repoRoot, sandbox },
      )
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('execution_error')
      }
      expect(spawnCalls).toBe(1)
      expect(await pathExists(fallbackCanary)).toBe(false)
    } finally {
      Bun.spawn = originalSpawn
    }
  })
})
