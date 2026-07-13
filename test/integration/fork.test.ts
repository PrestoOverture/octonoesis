// biome-ignore lint/suspicious/noExplicitAny: Bun subprocess handles are runtime-provided.
declare const Bun: any

import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type ForkResult,
  type PreparedFork,
  buildForkCommand,
  forkAgent,
  getActiveForkPids,
  serializeForkPayload,
} from '../../src/providers/fork'

const cliPath = resolve('src/cli.tsx')

interface TestSubprocess {
  pid: number
  exited: Promise<number>
  kill(signal: NodeJS.Signals): void
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function reapProcess(proc: TestSubprocess): Promise<void> {
  if (isProcessAlive(proc.pid)) {
    proc.kill('SIGKILL')
  }
  await proc.exited
}

async function runDirectForkChild(
  input: string,
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; pid: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn({
    cmd: buildForkCommand(process.execPath, cliPath),
    cwd: process.cwd(),
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  try {
    proc.stdin.write(input)
    await proc.stdin.end()
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, pid: proc.pid, stderr, stdout }
  } finally {
    await reapProcess(proc)
  }
}

async function waitForActiveForkPid(): Promise<number> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const pid = getActiveForkPids()[0]
    if (pid !== undefined) return pid
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
  throw new Error('Timed out waiting for a fork child PID')
}

async function waitForPidFile(path: string): Promise<number> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(path, 'utf8')).trim())
      if (Number.isInteger(pid) && pid > 0) return pid
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
  throw new Error('Timed out waiting for the parent harness PID file')
}

async function waitForProcessDeath(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
  return !isProcessAlive(pid)
}

async function withForkRuntime<T>(
  cwd: string,
  mock: { text: string; delayMs?: number },
  run: () => Promise<T>,
): Promise<T> {
  const originalMain = Bun.main
  const originalCwd = process.cwd()
  const originalMock = process.env.OCTONOESIS_FORK_MOCK
  const originalDepth = process.env.OCTONOESIS_FORK_DEPTH

  try {
    Bun.main = cliPath
    process.chdir(cwd)
    process.env.OCTONOESIS_FORK_MOCK = JSON.stringify(mock)
    Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_DEPTH')
    return await run()
  } finally {
    Bun.main = originalMain
    process.chdir(originalCwd)
    if (originalMock === undefined) {
      Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_MOCK')
    } else {
      process.env.OCTONOESIS_FORK_MOCK = originalMock
    }
    if (originalDepth === undefined) {
      Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_DEPTH')
    } else {
      process.env.OCTONOESIS_FORK_DEPTH = originalDepth
    }
  }
}

test('fork child round-trips a no-tool mock response without writing memory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'octonoesis-fork-'))
  const systemPrompt = 'stable\ncache-key\u0000\u4fdd\u6301'
  const prepared: PreparedFork = {
    repoRoot: cwd,
    systemPrompt,
    messages: [{ role: 'user', content: 'Summarize this paragraph.' }],
    tools: [],
    childEnv: { OCTONOESIS_FORK_DEPTH: '1' },
    budget: { maxTurns: 3 },
    purpose: 'compact',
    model: 'mock-model',
  }
  const proc = Bun.spawn({
    cmd: buildForkCommand(process.execPath, cliPath),
    cwd,
    env: {
      ...process.env,
      ...prepared.childEnv,
      OCTONOESIS_FORK_MOCK: JSON.stringify({ text: 'mock summary' }),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  try {
    proc.stdin.write(serializeForkPayload(prepared))
    await proc.stdin.end()

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const result = JSON.parse(stdout) as ForkResult

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.trim().split('\n').length).toBe(1)
    expect(result).toEqual({
      text: 'mock summary',
      usage: { input_tokens: 0, output_tokens: 0 },
      turns: 1,
      exitReason: 'completed',
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'),
    })
    expect(isProcessAlive(proc.pid)).toBe(false)
    expect(await Bun.file(join(cwd, '.octonoesis')).exists()).toBe(false)
  } finally {
    await reapProcess(proc)
    await rm(cwd, { recursive: true, force: true })
  }
})

test('forkAgent round-trips the prepared payload through the child process', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'octonoesis-fork-parent-'))
  const systemPrompt = 'parent stable prompt\n\u96f6\u5dee\u5f02'

  try {
    const result = await withForkRuntime(cwd, { text: 'parent mock summary' }, () =>
      forkAgent({
        systemPrompt,
        messages: [{ role: 'user', content: 'Summarize this.' }],
        tools: [],
        forkPurpose: 'compact',
      }),
    )

    expect(result).toEqual({
      text: 'parent mock summary',
      usage: { input_tokens: 0, output_tokens: 0 },
      turns: 1,
      exitReason: 'completed',
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'),
    })
    expect(await Bun.file(join(cwd, '.octonoesis')).exists()).toBe(false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('forkAgent aborts a running child and waits until its PID is dead', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'octonoesis-fork-abort-'))
  const controller = new AbortController()

  try {
    await withForkRuntime(cwd, { text: 'too late', delayMs: 5000 }, async () => {
      const resultPromise = forkAgent({
        systemPrompt: 'abort prompt',
        messages: [{ role: 'user', content: 'Wait.' }],
        tools: [],
        forkPurpose: 'compact',
        signal: controller.signal,
      })

      try {
        const pid = await waitForActiveForkPid()
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1600))
        controller.abort()
        const result = await resultPromise

        expect(result.exitReason).toBe('user_cancel')
        expect(isProcessAlive(pid)).toBe(false)
        expect(getActiveForkPids()).toEqual([])
      } finally {
        controller.abort()
        await resultPromise
      }
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('forkAgent times out a running child and returns a fatal error after reaping it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'octonoesis-fork-timeout-'))

  try {
    await withForkRuntime(cwd, { text: 'too late', delayMs: 5000 }, async () => {
      const resultPromise = forkAgent({
        systemPrompt: 'timeout prompt',
        messages: [{ role: 'user', content: 'Wait.' }],
        tools: [],
        forkPurpose: 'compact',
        timeoutMs: 1700,
      })

      try {
        const pid = await waitForActiveForkPid()
        const result = await resultPromise

        expect(result.exitReason).toBe('fatal_error')
        expect(result.error).toContain('timed out after 1700ms')
        expect(isProcessAlive(pid)).toBe(false)
        expect(getActiveForkPids()).toEqual([])
      } finally {
        await resultPromise
      }
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('fork child rejects a directly spawned depth-two process', async () => {
  const prepared: PreparedFork = {
    repoRoot: process.cwd(),
    systemPrompt: 'depth prompt',
    messages: [{ role: 'user', content: 'Do not recurse.' }],
    tools: [],
    childEnv: { OCTONOESIS_FORK_DEPTH: '1' },
    budget: { maxTurns: 1 },
    purpose: 'compact',
    model: 'mock-model',
  }
  const result = await runDirectForkChild(serializeForkPayload(prepared), {
    ...process.env,
    OCTONOESIS_FORK_DEPTH: '2',
    OCTONOESIS_FORK_MOCK: JSON.stringify({ text: 'must not run' }),
  })

  expect(result.exitCode).not.toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('depth exceeds')
  expect(isProcessAlive(result.pid)).toBe(false)
})

test('fork child rejects malformed stdin without producing protocol output', async () => {
  const result = await runDirectForkChild('{not-json', {
    ...process.env,
    OCTONOESIS_FORK_DEPTH: '1',
    OCTONOESIS_FORK_MOCK: JSON.stringify({ text: 'must not run' }),
  })

  expect(result.exitCode).not.toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('Fork child error')
  expect(isProcessAlive(result.pid)).toBe(false)
})

test('fork child rejects valid JSON with malformed message and tool entries', async () => {
  const result = await runDirectForkChild(
    JSON.stringify({
      systemPrompt: 'malformed structures',
      messages: [null],
      tools: [null],
      childEnv: { OCTONOESIS_FORK_DEPTH: '1' },
      budget: { maxTurns: 1 },
      purpose: 'compact',
      model: 'mock-model',
    }),
    {
      ...process.env,
      OCTONOESIS_FORK_DEPTH: '1',
      OCTONOESIS_FORK_MOCK: JSON.stringify({ text: 'must not run' }),
    },
  )

  expect(result.exitCode).not.toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('Invalid fork payload')
  expect(isProcessAlive(result.pid)).toBe(false)
})

test('forkAgent maps a non-zero child exit to a fatal result instead of throwing', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'octonoesis-fork-nonzero-'))

  try {
    await withForkRuntime(cwd, { text: 'unused' }, async () => {
      process.env.OCTONOESIS_FORK_MOCK = '{invalid-mock-json'
      const result = await forkAgent({
        systemPrompt: 'nonzero prompt',
        messages: [{ role: 'user', content: 'Fail in the child.' }],
        tools: [],
        forkPurpose: 'compact',
      })

      expect(result.exitReason).toBe('fatal_error')
      expect(result.error).toBeDefined()
      expect(getActiveForkPids()).toEqual([])
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('forkAgent maps malformed child stdout to a fatal result', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'octonoesis-fork-output-'))
  const malformedChild = join(cwd, 'malformed-child.ts')
  await writeFile(malformedChild, "await Bun.stdin.text()\nconsole.log('not-json')\n", 'utf8')

  try {
    await withForkRuntime(cwd, { text: 'unused' }, async () => {
      Bun.main = malformedChild
      const result = await forkAgent({
        systemPrompt: 'malformed output prompt',
        messages: [{ role: 'user', content: 'Return malformed output.' }],
        tools: [],
        forkPurpose: 'compact',
      })

      expect(result.exitReason).toBe('fatal_error')
      expect(result.error).toBeDefined()
      expect(getActiveForkPids()).toEqual([])
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a signal-terminated parent force-kills its registered fork child', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'octonoesis-fork-parent-exit-'))
  const harnessPath = join(cwd, 'parent-harness.ts')
  const childPidPath = join(cwd, 'child.pid')
  const forkModuleUrl = pathToFileURL(resolve('src/providers/fork.ts')).href
  const childModuleUrl = pathToFileURL(resolve('src/providers/forkChild.ts')).href
  await writeFile(
    harnessPath,
    `import { forkAgent, getActiveForkPids } from ${JSON.stringify(forkModuleUrl)}
if (process.argv.includes('--fork-child')) {
  const { forkChildMain } = await import(${JSON.stringify(childModuleUrl)})
  process.exit(await forkChildMain())
}
const pidFile = process.env.FORK_PID_FILE
if (!pidFile) throw new Error('FORK_PID_FILE is required')
const resultPromise = forkAgent({
  systemPrompt: 'parent exit prompt',
  messages: [{ role: 'user', content: 'Wait.' }],
  tools: [],
  forkPurpose: 'compact',
})
while (getActiveForkPids().length === 0) await Bun.sleep(10)
await Bun.write(pidFile, String(getActiveForkPids()[0]))
await resultPromise
`,
    'utf8',
  )

  const env = {
    ...process.env,
    FORK_PID_FILE: childPidPath,
    OCTONOESIS_FORK_MOCK: JSON.stringify({ text: 'too late', delayMs: 10_000 }),
  }
  Reflect.deleteProperty(env, 'OCTONOESIS_FORK_DEPTH')
  const parent = Bun.spawn({
    cmd: [process.execPath, harnessPath],
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdoutPromise = new Response(parent.stdout).text()
  const stderrPromise = new Response(parent.stderr).text()
  let childPid: number | undefined

  try {
    childPid = await waitForPidFile(childPidPath)
    expect(isProcessAlive(childPid)).toBe(true)

    parent.kill('SIGTERM')
    await parent.exited

    expect(await waitForProcessDeath(childPid)).toBe(true)
  } finally {
    if (isProcessAlive(parent.pid)) parent.kill('SIGKILL')
    await parent.exited
    if (childPid !== undefined && isProcessAlive(childPid)) {
      process.kill(childPid, 'SIGKILL')
      await waitForProcessDeath(childPid)
    }
    await Promise.allSettled([stdoutPromise, stderrPromise])
    await rm(cwd, { recursive: true, force: true })
  }
})
