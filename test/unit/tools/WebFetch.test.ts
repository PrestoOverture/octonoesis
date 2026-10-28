import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseConfig } from '../../../src/config/schema'
import { flushJournal } from '../../../src/memory/journal'
import {
  clearAllowlist,
  registerPromptHandler,
  unregisterPromptHandler,
} from '../../../src/permissions/confirm'
import type { Tool, ToolResult } from '../../../src/tools/Tool'
import { WebFetchTool, isPrivateAddress, webFetchTool } from '../../../src/tools/WebFetch'
import { runTool } from '../../../src/tools/execute'
import { registerTool } from '../../../src/tools/registry'
import { restoreEnv } from '../../helpers/env'
import { restoreRegistry, snapshotRegistry } from '../../helpers/globalState'

// This project's TypeScript configuration uses Node types; Bun is the test runtime.
// biome-ignore lint/suspicious/noExplicitAny: Bun runtime server API
declare const Bun: any
const { spyOn } = require('bun:test')

let server: { port: number; stop(force: boolean): void }
let root: string
let savedMemoryDir: string | undefined
let originalTools: Tool[]
let requests: string[]
let prompts: unknown[]
let fetchSpy: ReturnType<typeof spyOn>
const fixtureHost = 'fixture.test'
const resolveFixture = async () => ['127.0.0.1']
const fixturePrivateCheck = (address: string, hostname: string) =>
  hostname === fixtureHost ? false : isPrivateAddress(address)

function fixtureTool(timeoutMs?: number) {
  return new WebFetchTool({
    resolve: resolveFixture,
    isPrivateAddress: fixturePrivateCheck,
    timeoutMs,
  })
}
function url(route = '/', hostname = fixtureHost): string {
  return `http://${hostname}:${server.port}${route}`
}
async function run(input: unknown) {
  return runTool('WebFetch', input, { repoRoot: root })
}
function value(result: ToolResult): string {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error)
  return String(result.value)
}
function error(result: ToolResult): string {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error(String(result.value))
  return result.error
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'webfetch-'))
  savedMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
  process.env.OCTONOESIS_MEMORY_DIR = root
  originalTools = snapshotRegistry()
  requests = []
  prompts = []
  clearAllowlist()
  registerPromptHandler(async (_name, input) => {
    prompts.push(input)
    return 'allow_once'
  })
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request: Request) {
      requests.push(request.headers.get('host') ?? '')
      const requestUrl = new URL(request.url)
      const route = requestUrl.pathname
      if (route === '/html') {
        return new Response(
          '<h1>Heading &amp; title</h1><script>script-secret</script>' +
            '<style>style-secret</style><nav><p>nav-secret</p></nav>' +
            '<footer>footer-secret</footer><p>A <a href="/target">useful link</a>.</p>' +
            '<ul><li>First item</li><li>Second item</li></ul>' +
            '<pre><code>const x = 1;\n  x &lt; 2;</code></pre><p>Use <code>x()</code>.</p>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        )
      }
      if (route === '/long') return new Response('x'.repeat(210_000))
      if (route === '/long-html')
        return new Response(`<p>${'x'.repeat(210_000)}</p>`, {
          headers: { 'content-type': 'text/html' },
        })
      if (route === '/binary') {
        return new Response(new Uint8Array([0, 1, 2]), {
          headers: { 'content-type': 'image/png' },
        })
      }
      if (route === '/json') {
        return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
      }
      if (route === '/redirect') {
        return new Response(null, {
          status: 302,
          headers: { location: requestUrl.searchParams.get('to') ?? '/html' },
        })
      }
      if (route.startsWith('/chain/')) {
        const count = Number(route.split('/').at(-1))
        return count === 0
          ? new Response('arrived')
          : new Response(null, { status: 302, headers: { location: `/chain/${count - 1}` } })
      }
      if (route === '/slow') return new Promise<Response>(() => {})
      if (route === '/slow-body') {
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array([65]))
            },
          }),
          {
            headers: { 'content-type': 'text/plain' },
          },
        )
      }
      return new Response('plain text')
    },
  })
  const realFetch = globalThis.fetch
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    (target: RequestInfo | URL, options?: RequestInit) => {
      const destination = new URL(target instanceof Request ? target.url : String(target))
      if (destination.hostname !== '127.0.0.1' || destination.port !== String(server.port)) {
        throw new Error('Test refused a request outside its local fixture server.')
      }
      return realFetch(target, options)
    },
  )
  registerTool(fixtureTool())
})

afterEach(async () => {
  fetchSpy?.mockRestore()
  server?.stop(true)
  unregisterPromptHandler()
  clearAllowlist()
  restoreRegistry(originalTools)
  await flushJournal()
  restoreEnv('OCTONOESIS_MEMORY_DIR', savedMemoryDir)
  await fs.rm(root, { recursive: true, force: true })
})

describe('WebFetch', () => {
  it('is read-only and serializes possible permission prompts', () => {
    expect(webFetchTool.name).toBe('WebFetch')
    expect(webFetchTool.isReadOnly()).toBe(true)
    expect(webFetchTool.isConcurrencySafe()).toBe(false)
  })

  it('converts HTML to readable headings, paragraphs, lists, links and code', async () => {
    const output = value(await run({ url: url('/html') }))
    expect(output.startsWith(`[Untrusted web content from ${url('/html')}]\n`)).toBe(true)
    expect(output).toContain('# Heading & title')
    expect(output).toContain(`A useful link (${url('/target')}).`)
    expect(output).toContain('- First item')
    expect(output).toContain('- Second item')
    expect(output).toContain('const x = 1;\n  x < 2;')
    expect(output).toContain('`x()`')
    for (const secret of ['script-secret', 'style-secret', 'nav-secret', 'footer-secret']) {
      expect(output).not.toContain(secret)
    }
    expect(output).not.toContain('<h1>')
    // The socket uses the injected, checked IP while the HTTP Host retains the origin.
    expect(requests).toEqual([`${fixtureHost}:${server.port}`])
  })

  it('caps content at max_chars and appends a truncation footer (default 50k, max 200k)', async () => {
    for (const max of [12, 50_000, 200_000]) {
      const output = value(
        await run({ url: url('/long'), ...(max === 50_000 ? {} : { max_chars: max }) }),
      )
      expect(output).toContain(`\n${'x'.repeat(max)}\n[Content truncated at ${max} characters]`)
      expect(output).not.toContain('x'.repeat(max + 1))
    }
    for (const max_chars of [0, -1, 1.5, 200_001]) {
      expect(error(await run({ url: url(), max_chars }))).toContain('invalid_input')
    }
  })

  it('truncates HTML content with the same footer', async () => {
    const output = value(await run({ url: url('/long-html'), max_chars: 12 }))
    expect(output).toBe(
      `[Untrusted web content from ${url('/long-html')}]\n${'x'.repeat(12)}\n[Content truncated at 12 characters]`,
    )
  })

  it('does not truncate content at the exact limit', async () => {
    expect(value(await run({ url: url(), max_chars: 10 }))).toBe(
      `[Untrusted web content from ${url()}]\nplain text`,
    )
  })

  it('passes non-HTML textual responses through unchanged', async () => {
    expect(value(await run({ url: url() })).endsWith('\nplain text')).toBe(true)
    expect(value(await run({ url: url('/json') })).endsWith('\n{"ok":true}')).toBe(true)
  })

  it('rejects non-http(s) inputs before any request or permission prompt', async () => {
    for (const target of [
      'file:///etc/passwd',
      'ftp://fixture.test',
      'data:text/plain,secret',
      'bad',
    ]) {
      expect(error(await run({ url: target }))).toContain('invalid_input')
    }
    expect(requests.length).toBe(0)
    expect(prompts.length).toBe(0)
  })

  it('rejects binary responses', async () => {
    expect(error(await run({ url: url('/binary') }))).toContain('binary_content')
  })

  it('refuses literal localhost, loopback, link-local, RFC1918, ULA and metadata targets', async () => {
    registerTool(new WebFetchTool({ resolve: async () => ['93.184.216.34'] }))
    for (const host of [
      'localhost',
      'localhost.',
      'sub.localhost',
      '127.0.0.1',
      '127.1',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.2.3',
      '169.254.1.2',
      '169.254.169.254',
      '100.100.100.200',
      '[::1]',
      '[::]',
      '[fe80::1]',
      '[fc00::1]',
      '[fd00:ec2::254]',
      '[::ffff:127.0.0.1]',
      '[::ffff:192.168.1.1]',
    ]) {
      expect(error(await run({ url: `http://${host}/` }))).toContain('private_network')
    }
    expect(requests.length).toBe(0)
  })

  it('checks all DNS answers and refuses hostnames resolving to private or metadata IPs', async () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.20.0.1',
      '192.168.0.1',
      '169.254.169.254',
      'fd12::1',
    ]) {
      registerTool(new WebFetchTool({ resolve: async () => ['93.184.216.34', address] }))
      expect(error(await run({ url: url() }))).toContain('private_network')
    }
    expect(requests.length).toBe(0)
  })

  it('rechecks redirect destinations, including DNS and the protocol', async () => {
    for (const destination of [
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://169.254.169.254/',
      'http://private.test/',
      'file:///etc/passwd',
    ]) {
      const result = await run({ url: url(`/redirect?to=${encodeURIComponent(destination)}`) })
      expect(error(result)).toContain(
        destination.startsWith('file:') ? 'invalid_url' : 'private_network',
      )
    }
    expect(requests.length).toBe(5)
  })

  it('allows exactly five redirects and uses the final URL in the label', async () => {
    expect(value(await run({ url: url('/chain/5') }))).toBe(
      `[Untrusted web content from ${url('/chain/0')}]\narrived`,
    )
    expect(requests.length).toBe(6)
    expect(prompts.length).toBe(1)
    requests = []
    expect(error(await run({ url: url('/chain/6') }))).toContain('too_many_redirects')
    expect(requests.length).toBe(6)
  })

  it('prompts once per host after always, including different paths and max_chars', async () => {
    registerPromptHandler(async (_name, input) => {
      prompts.push(input)
      return 'allow_always'
    })
    expect(value(await run({ url: url() }))).toContain('plain text')
    expect(value(await run({ url: url('/json'), max_chars: 20 }))).toContain('{"ok":true}')
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toEqual({ url: url() })
    clearAllowlist()
    await run({ url: url() })
    expect(prompts.length).toBe(2)
  })

  it('allow_once prompts again and denial prevents the request', async () => {
    await run({ url: url() })
    await run({ url: url() })
    expect(prompts.length).toBe(2)
    registerPromptHandler(async () => 'deny')
    expect(error(await run({ url: url() }))).toContain('permission_denied')
    expect(requests.length).toBe(2)
  })

  it('requests separate permission for a redirect host', async () => {
    registerTool(new WebFetchTool({ resolve: resolveFixture, isPrivateAddress: () => false }))
    registerPromptHandler(async (_name, input) => {
      prompts.push(input)
      return prompts.length === 1 ? 'allow_always' : 'deny'
    })
    expect(
      error(await run({ url: url(`/redirect?to=${encodeURIComponent(url('/', 'other.test'))}`) })),
    ).toContain('permission_denied')
    expect(prompts.length).toBe(2)
    expect(requests.length).toBe(1)
  })

  it('rechecks DNS even after a host has session permission', async () => {
    let resolutions = 0
    registerTool(
      new WebFetchTool({
        resolve: async () => (++resolutions === 1 ? ['127.0.0.1'] : ['10.0.0.1']),
        isPrivateAddress: (address) =>
          address === '127.0.0.1' ? false : isPrivateAddress(address),
      }),
    )
    registerPromptHandler(async () => 'allow_always')
    value(await run({ url: url() }))
    expect(error(await run({ url: url() }))).toContain('private_network')
    expect(requests.length).toBe(1)
  })

  it('allows private networks only with the explicit config override', async () => {
    registerTool(new WebFetchTool({ resolve: resolveFixture }))
    expect(parseConfig({}).webFetch?.allowPrivateNetwork ?? false).toBe(false)
    expect(error(await run({ url: url() }))).toContain('private_network')
    const config = parseConfig({ webFetch: { allowPrivateNetwork: true } })
    expect(value(await runTool('WebFetch', { url: url() }, { repoRoot: root, config }))).toContain(
      'plain text',
    )
    expect(() => parseConfig({ webFetch: { allowPrivateNetwork: 'yes' } })).toThrow()
    expect(() => parseConfig({ webFetch: { typo: true } })).toThrow()
  })

  it('returns tool errors on timeout before headers and while reading the body', async () => {
    registerTool(fixtureTool(30))
    for (const route of ['/slow', '/slow-body']) {
      expect(error(await run({ url: url(route) }))).toContain('timeout:')
    }
  })

  it('bounds stalled DNS resolution with the timeout too', async () => {
    registerTool(new WebFetchTool({ resolve: () => new Promise(() => {}), timeoutMs: 30 }))
    expect(error(await run({ url: url() }))).toContain('timeout:')
    expect(requests.length).toBe(0)
  })

  it('honors cancellation while waiting for a response', async () => {
    const controller = new AbortController()
    const result = runTool(
      'WebFetch',
      { url: url('/slow') },
      { repoRoot: root, abortSignal: controller.signal },
    )
    setTimeout(() => controller.abort(), 30)
    expect(error(await result)).toContain('aborted:')
  })

  it('journals permission and tool outcomes through the existing pipeline', async () => {
    await run({ url: url() })
    await flushJournal()
    const rows = (await fs.readFile(path.join(root, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(rows.map((row) => row.kind)).toEqual(['permission', 'tool'])
    expect(rows[1].tool).toBe('WebFetch')
    expect(rows[1].outcome).toBe('success')
    expect(rows[1].error_class).toBe(null)
  })
})
