// biome-ignore lint/suspicious/noExplicitAny: Bun subprocess handles are runtime-provided.
declare const Bun: any

import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const cli = resolve('src/cli.tsx')
const preload = resolve('test/fixtures/signal-shutdown/preload.ts')

async function launch(
  options: { tui?: boolean; hang?: boolean; fork?: boolean },
  check: (child: ReturnType<typeof Bun.spawn>, output: () => string, dir: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'octonoesis-signals-'))
  const child = Bun.spawn({
    cmd: [process.execPath, '--preload', preload, cli, ...(options.tui ? [] : ['wait'])],
    cwd: dir,
    env: {
      ...process.env,
      OCTONOESIS_REPO_ROOT: dir,
      OCTONOESIS_MEMORY_DIR: dir,
      OCTONOESIS_DISABLE_MEMORY: '0',
      ANTHROPIC_API_KEY: 'fake',
      LLM_PROVIDER: 'anthropic',
      SIGNAL_TEST_TUI: options.tui ? '1' : '0',
      SIGNAL_TEST_HANG: options.hang ? '1' : '0',
      SIGNAL_TEST_FORK: options.fork ? '1' : '0',
      OCTONOESIS_FORK_MOCK: JSON.stringify({ text: 'late', delayMs: 60_000 }),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let output = ''
  async function drain(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      output += decoder.decode(value, { stream: true })
    }
  }
  const drains = [drain(child.stdout), drain(child.stderr)]
  try {
    await until(
      () => output.includes(options.tui ? 'TUI_READY' : 'PROVIDER_READY'),
      () => output,
    )
    await check(child, () => output, dir)
  } finally {
    child.kill('SIGKILL')
    await child.exited
    await Promise.all(drains)
    const pid = Number(output.match(/FORK_PID=(\d+)/)?.[1])
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
}

async function until(condition: () => boolean, output: () => string, timeout = 5000) {
  const start = performance.now()
  while (!condition()) {
    if (performance.now() - start > timeout) throw new Error(`Timed out: ${output()}`)
    await Bun.sleep(10)
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

for (const [signal, code] of [
  ['SIGTERM', 143],
  ['SIGINT', 130],
  ['SIGHUP', 129],
] as const) {
  test(`TUI gracefully handles ${signal} and kills fork children`, async () => {
    await launch({ tui: true, fork: true }, async (child, output) => {
      await until(() => output().includes('FORK_PID='), output)
      const pid = Number(output().match(/FORK_PID=(\d+)/)?.[1])
      expect(alive(pid)).toBe(true)
      const start = performance.now()
      child.kill(signal)
      await until(() => child.exitCode !== null, output, 3000)
      expect(await child.exited).toBe(code)
      expect(performance.now() - start).toBeLessThan(3000)
      await until(() => output().includes('Session summary:'), output)
      expect(output()).toContain('\x1b[?25h')
      expect(output()).toContain('RAW_OFF')
      await until(() => !alive(pid), output)
    })
  })
}

for (const [signal, code] of [
  ['SIGTERM', 143],
  ['SIGINT', 130],
  ['SIGHUP', 129],
] as const) {
  test(`one-shot ${signal} aborts streaming and journals session end`, async () => {
    await launch({}, async (child, output, dir) => {
      const start = performance.now()
      child.kill(signal)
      await until(() => child.exitCode !== null, output, 3000)
      expect(await child.exited).toBe(code)
      expect(performance.now() - start).toBeLessThan(3000)
      await until(() => output().includes('Session summary:'), output)
      expect(output()).toContain('PROVIDER_ABORTED')
      const records = (await readFile(join(dir, 'journal.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(
        records.some((record) => record.kind === 'session' && record.exit_reason === 'user_cancel'),
      ).toBe(true)
    })
  })
}

test('TUI signal aborts an active query before flushing its journal', async () => {
  await launch({ tui: true }, async (child, output, dir) => {
    const stdin = child.stdin
    if (!stdin || typeof stdin === 'number') throw new Error('Expected piped stdin')
    stdin.write('wait')
    stdin.flush()
    await Bun.sleep(100)
    stdin.write('\r')
    stdin.flush()
    await until(() => output().includes('PROVIDER_READY'), output)
    child.kill('SIGTERM')
    await until(() => child.exitCode !== null, output, 3000)
    expect(await child.exited).toBe(143)
    await until(() => output().includes('Session summary:'), output)
    expect(output()).toContain('PROVIDER_ABORTED')
    expect(output()).toContain('\x1b[?25h')
    const records = (await readFile(join(dir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(
      records.some((record) => record.kind === 'session' && record.exit_reason === 'user_cancel'),
    ).toBe(true)
  })
})

test('Ctrl+C keypress still cancels generation, then exits normally when idle', async () => {
  await launch({ tui: true }, async (child, output) => {
    child.stdin.write('wait')
    child.stdin.flush()
    await Bun.sleep(100)
    child.stdin.write('\r')
    child.stdin.flush()
    await until(() => output().includes('PROVIDER_READY'), output)
    child.stdin.write('\x03')
    child.stdin.flush()
    await until(() => output().includes('PROVIDER_ABORTED'), output)
    await Bun.sleep(100)
    expect(child.exitCode).toBe(null)
    child.stdin.write('\x03')
    child.stdin.flush()
    await until(() => child.exitCode !== null, output, 3000)
    expect(await child.exited).toBe(0)
    await until(() => output().includes('Session summary:'), output)
    expect(output()).toContain('\x1b[?25h')
  })
})

for (const tui of [true, false]) {
  for (const second of [false, true]) {
    test(`${tui ? 'TUI' : 'one-shot'} hung cleanup force exits ${second ? 'on second signal' : 'at deadline'}`, async () => {
      await launch({ tui, hang: true }, async (child, output) => {
        const start = performance.now()
        child.kill('SIGTERM')
        await until(() => output().includes('CLEANUP_HANG'), output)
        let secondAt = 0
        if (second) {
          secondAt = performance.now()
          child.kill('SIGHUP')
        }
        await until(() => child.exitCode !== null, output, 4000)
        expect(await child.exited).toBe(143)
        if (second) expect(performance.now() - secondAt).toBeLessThan(1000)
        else {
          expect(performance.now() - start).toBeGreaterThan(2900)
          expect(performance.now() - start).toBeLessThan(3500)
        }
      })
    })
  }
}
