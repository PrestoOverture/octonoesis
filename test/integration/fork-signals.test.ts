// biome-ignore lint/suspicious/noExplicitAny: Bun subprocess handles are runtime-provided.
declare const Bun: any

import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Subprocess timed out')), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`importing fork without a signal owner preserves ${signal} termination`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'octonoesis-fork-signals-'))
    const moduleUrl = pathToFileURL(resolve('src/providers/fork.ts')).href
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        `import ${JSON.stringify(moduleUrl)}; setInterval(() => {}, 1000); console.log('READY')`,
      ],
      cwd: dir,
      env: {
        ...process.env,
        OCTONOESIS_REPO_ROOT: dir,
        OCTONOESIS_MEMORY_DIR: dir,
        OCTONOESIS_DISABLE_MEMORY: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const reader: ReadableStreamDefaultReader<Uint8Array> = child.stdout.getReader()
    const stderr = new Response(child.stderr).text()
    try {
      const ready = await within(reader.read(), 2000)
      expect(new TextDecoder().decode(ready.value)).toContain('READY')
      const start = performance.now()
      child.kill(signal)
      await within(child.exited, 2000)
      expect(performance.now() - start).toBeLessThan(2000)
    } finally {
      child.kill('SIGKILL')
      await child.exited
      await reader.cancel()
      await stderr
      await rm(dir, { recursive: true, force: true })
    }
  })
}
