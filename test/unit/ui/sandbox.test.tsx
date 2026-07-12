import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { render } from 'ink-testing-library'
import React from 'react'
import { setProvider } from '../../../src/providers'
import type { LLMProvider, StreamEvent } from '../../../src/providers/types'
import { resolveSandboxConfig } from '../../../src/sandbox/manager'
import { bashTool } from '../../../src/tools/Bash'
import { App } from '../../../src/ui/App'

const describeDarwin = (
  describe as typeof describe & { skipIf: (condition: boolean) => typeof describe }
).skipIf(process.platform !== 'darwin')

async function waitForFrame(
  lastFrame: () => string | undefined,
  expected: string,
): Promise<string> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const frame = lastFrame() ?? ''
    if (frame.includes(expected)) return frame
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return lastFrame() ?? ''
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

describeDarwin('App sandbox context', () => {
  let root: string
  let originalMemoryDir: string | undefined
  let originalDisableMemory: string | undefined
  let originalDisableCompact: string | undefined

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'octonoesis-ui-sandbox-'))
    originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
    originalDisableMemory = process.env.OCTONOESIS_DISABLE_MEMORY
    originalDisableCompact = process.env.OCTONOESIS_DISABLE_COMPACT
    process.env.OCTONOESIS_MEMORY_DIR = path.join(root, 'memory')
    process.env.OCTONOESIS_DISABLE_MEMORY = '1'
    process.env.OCTONOESIS_DISABLE_COMPACT = '1'
  })

  afterEach(async () => {
    setProvider(null)
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

  it('keeps the TUI permission dialog and confines the approved Bash command', async () => {
    const repoRoot = path.join(root, 'repo')
    const homeDir = path.join(root, 'home')
    const tmpDir = path.join(root, 'tmp')
    const canaryPath = path.join(homeDir, '.ssh', 'id_rsa')
    await Promise.all([
      mkdir(path.join(repoRoot, '.octonoesis'), { recursive: true }),
      mkdir(path.dirname(canaryPath), { recursive: true }),
      mkdir(tmpDir, { recursive: true }),
    ])
    await writeFile(canaryPath, 'tui-sandbox-secret', 'utf8')
    const sandbox = resolveSandboxConfig({
      repoRoot,
      cliEnabled: true,
      environment: { homeDir, tmpDir },
    })
    const command = `cat ${shellQuote(canaryPath)}`
    const control = await bashTool.call({ command }, { repoRoot })
    expect(control.ok).toBe(true)
    if (control.ok) {
      const output = JSON.parse(control.value)
      expect(output.code).toBe(0)
      expect(output.stdout).toContain('tui-sandbox-secret')
    }

    let mainTurn = 0
    let observedDeniedResult = false
    const provider: LLMProvider = {
      name: 'anthropic',
      async *createMessageStream(messages, tools): AsyncIterable<StreamEvent> {
        if (tools.length === 0) {
          yield {
            type: 'text_delta',
            text: '{"tool":"cat","error_class":"PermissionError","file":"","expression":""}',
          }
          yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
          return
        }

        mainTurn++
        if (mainTurn === 1) {
          yield {
            type: 'tool_use',
            id: 'tui-sandbox-bash',
            name: 'Bash',
            input: { command },
          }
          yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
          return
        }

        const toolMessage = messages.at(-1)
        if (toolMessage?.role === 'tool' && typeof toolMessage.content === 'string') {
          const output = JSON.parse(toolMessage.content)
          observedDeniedResult =
            output.code !== 0 && !toolMessage.content.includes('tui-sandbox-secret')
        }
        yield { type: 'text_delta', text: 'TUI sandbox observed' }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    }
    setProvider(provider)

    const view = render(<App sandbox={sandbox} />)
    try {
      view.stdin.write('run the sandbox probe')
      await new Promise((resolve) => setTimeout(resolve, 20))
      view.stdin.write('\r')
      const permissionFrame = await waitForFrame(view.lastFrame, 'Permission Required')
      expect(permissionFrame).toContain('Permission Required')
      expect(permissionFrame).toContain('Bash')

      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        view.stdin.write('y')
        await new Promise((resolve) => setTimeout(resolve, 50))
        if (!(view.lastFrame() ?? '').includes('Permission Required')) break
      }
      const finalFrame = await waitForFrame(view.lastFrame, 'TUI sandbox observed')
      expect(finalFrame).toContain('TUI sandbox observed')
      expect(observedDeniedResult).toBe(true)
    } finally {
      view.unmount()
    }
  })
})
