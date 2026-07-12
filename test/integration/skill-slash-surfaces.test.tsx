// biome-ignore lint/suspicious/noExplicitAny: Bun globals are provided by the test runtime.
declare const Bun: any

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { render } from 'ink-testing-library'
import React from 'react'
import { setProvider } from '../../src/providers'
import type { CanonicalMessage, LLMProvider, StreamEvent } from '../../src/providers/types'
import { query } from '../../src/query'
import { clearSkillCacheForTesting } from '../../src/skills/loader'
import { bashTool } from '../../src/tools/Bash'
import { editTool } from '../../src/tools/Edit'
import { globTool } from '../../src/tools/Glob'
import { grepTool } from '../../src/tools/Grep'
import { readTool } from '../../src/tools/Read'
import { todoWriteTool } from '../../src/tools/TodoWrite'
import { writeTool } from '../../src/tools/Write'
import { clearRegistry, getTool, registerTool } from '../../src/tools/registry'
import { App } from '../../src/ui/App'

const originalRepoRoot = process.env.OCTONOESIS_REPO_ROOT
const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
const originalDisableMemory = process.env.OCTONOESIS_DISABLE_MEMORY
const roots: string[] = []

async function repoFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'slash-surface-'))
  roots.push(root)
  const skills = path.join(root, '.octonoesis/skills')
  await mkdir(skills, { recursive: true })
  await writeFile(path.join(skills, 'audit.md'), '---\ndescription: Audit\n---\nAudit carefully.')
  process.env.OCTONOESIS_REPO_ROOT = root
  process.env.OCTONOESIS_MEMORY_DIR = path.join(root, 'memory-out')
  process.env.OCTONOESIS_DISABLE_MEMORY = '1'
  return root
}

afterEach(async () => {
  setProvider(null)
  clearSkillCacheForTesting()
  clearRegistry()
  for (const tool of [readTool, globTool, bashTool, writeTool, editTool, grepTool, todoWriteTool]) {
    registerTool(tool)
  }
  for (const [key, value] of Object.entries({
    OCTONOESIS_REPO_ROOT: originalRepoRoot,
    OCTONOESIS_MEMORY_DIR: originalMemoryDir,
    OCTONOESIS_DISABLE_MEMORY: originalDisableMemory,
  })) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function userText(messages: CanonicalMessage[]): string {
  const user = [...messages].reverse().find((message) => message.role === 'user')
  if (!user || user.role !== 'user') return ''
  return typeof user.content === 'string'
    ? user.content
    : user.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

describe('skill slash call sites', () => {
  test('a skill-less repository has neither catalog bytes nor a Skill tool', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'slash-surface-empty-'))
    roots.push(root)
    process.env.OCTONOESIS_REPO_ROOT = root
    process.env.OCTONOESIS_MEMORY_DIR = path.join(root, 'memory-out')
    process.env.OCTONOESIS_DISABLE_MEMORY = '1'
    let system = ''
    let toolNames: string[] = []
    const provider: LLMProvider = {
      name: 'anthropic',
      async *createMessageStream(_messages, tools, options): AsyncIterable<StreamEvent> {
        system = options.system ?? ''
        toolNames = tools.map((tool) => tool.name)
        yield { type: 'text_delta', text: 'ok' }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    }
    setProvider(provider)
    for await (const _event of query('plain input', { repoRoot: root })) {
      // Drain the complete query so registration and final hooks run.
    }
    expect(system).not.toContain('## Skills')
    expect(toolNames.includes('Skill')).toBe(false)
    expect(getTool('Skill')).toBeUndefined()
  })

  test('the TUI rewrites a known skill before querying', async () => {
    await repoFixture()
    let received = ''
    let system = ''
    let toolNames: string[] = []
    const provider: LLMProvider = {
      name: 'anthropic',
      async *createMessageStream(messages, tools, options): AsyncIterable<StreamEvent> {
        received = userText(messages)
        system = options.system ?? ''
        toolNames = tools.map((tool) => tool.name)
        yield { type: 'text_delta', text: 'ok' }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    }
    setProvider(provider)
    const { stdin, unmount } = render(<App />)
    stdin.write('/audit check src')
    await new Promise((resolve) => setTimeout(resolve, 50))
    stdin.write('\r')
    const deadline = Date.now() + 2_000
    while (!received && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20))
    expect(received).toBe('Invoke the skill "audit" via the Skill tool with args: check src')
    expect(system).toContain('## Skills')
    expect(toolNames.includes('Skill')).toBe(true)
    unmount()
  })

  test('the one-shot CLI rewrites a known skill before the provider request', async () => {
    const root = await repoFixture()
    let received = ''
    const server = Bun.serve({
      port: 0,
      async fetch(request: Request) {
        const body = (await request.json()) as {
          messages?: Array<{ role: string; content: string }>
        }
        received =
          [...(body.messages ?? [])].reverse().find((message) => message.role === 'user')
            ?.content ?? ''
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    try {
      const proc = Bun.spawn({
        cmd: [process.execPath, path.join(process.cwd(), 'src/cli.tsx'), '/audit check src'],
        cwd: root,
        env: {
          ...process.env,
          LLM_PROVIDER: 'openai',
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
      expect(exitCode).toBe(0)
      expect(stderr).toBe('')
      expect(received).toBe('Invoke the skill "audit" via the Skill tool with args: check src')
    } finally {
      server.stop(true)
    }
  })
})
