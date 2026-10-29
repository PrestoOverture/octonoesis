import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { z } from 'zod'
import { requestPermission } from '../permissions/confirm'
import type { Tool, ToolContext, ToolResult } from './Tool'

// Bun supplies HTMLRewriter at runtime; this project uses Node's TypeScript globals.
interface HtmlElement {
  tagName: string
  getAttribute(name: string): string | null
  onEndTag(handler: () => void): void
}
interface HtmlRewriter {
  on(selector: string, handler: { element(element: HtmlElement): void }): HtmlRewriter
  onDocument(handler: { text(chunk: { text: string }): void }): HtmlRewriter
  transform(response: Response): Response
}
declare const HTMLRewriter: { new (): HtmlRewriter }

const inputSchema = z.object({
  url: z.string().refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol)
    } catch {
      return false
    }
  }, 'url must be an absolute http or https URL'),
  max_chars: z.number().int().positive().max(200_000).default(50_000),
})
type WebFetchInput = z.infer<typeof inputSchema>

const privateAddresses = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  privateAddresses.addSubnet(address, prefix, 'ipv4')
}
privateAddresses.addAddress('100.100.100.200', 'ipv4') // Alibaba metadata
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  privateAddresses.addSubnet(address, prefix, 'ipv6')
}

/** Includes IPv4 embedded in IPv6 transition addresses; invalid DNS answers fail closed. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0 || privateAddresses.check(address, family === 6 ? 'ipv6' : 'ipv4')) return true
  if (family !== 6) return false
  const ipv4 = embeddedIPv4(address)
  return ipv4 !== undefined && privateAddresses.check(ipv4, 'ipv4')
}

function embeddedIPv4(address: string): string | undefined {
  if (isIP(address) === 4) return address
  if (isIP(address) !== 6) return undefined
  // URL canonicalization converts dotted IPv4 tails to hex before expanding ::.
  const canonical = new URL(`http://[${address.split('%')[0]}]/`).hostname.slice(1, -1)
  const [head = '', tail] = canonical.split('::')
  const leading = head ? head.split(':') : []
  const trailing = tail ? tail.split(':') : []
  const words =
    tail === undefined
      ? leading
      : [...leading, ...Array<string>(8 - leading.length - trailing.length).fill('0'), ...trailing]
  const hex = words.map((word) => word.padStart(4, '0')).join('')
  let embedded: string
  if (
    hex.startsWith('000000000000000000000000') || // IPv4-compatible
    hex.startsWith('00000000000000000000ffff') || // IPv4-mapped
    hex.startsWith('0000000000000000ffff0000') || // IPv4-translated
    hex.startsWith('0064ff9b0000000000000000') // NAT64 /96
  ) {
    embedded = hex.slice(24)
  } else if (hex.startsWith('0064ff9b0001')) {
    // RFC 6052 /48: IPv4 occupies bits 48..63 and 72..87, skipping the reserved byte.
    embedded = hex.slice(12, 16) + hex.slice(18, 22)
  } else if (hex.startsWith('2002')) {
    embedded = hex.slice(4, 12) // 6to4 embeds IPv4 immediately after 2002::/16.
  } else {
    return undefined
  }
  return [0, 2, 4, 6]
    .map((offset) => Number.parseInt(embedded.slice(offset, offset + 2), 16))
    .join('.')
}

const fakeIpAddresses = new BlockList()
fakeIpAddresses.addSubnet('198.18.0.0', 15, 'ipv4')

interface WebFetchOptions {
  resolve?: (hostname: string) => Promise<string[]>
  isPrivateAddress?: (address: string, hostname: string) => boolean
  timeoutMs?: number
}

/** Stop awaiting DNS/rewriting as well as socket I/O when cancelled or timed out. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
}
function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity] ?? whole
    const code =
      entity[1]?.toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�'
  })
}

/** HTMLRewriter parses structure; only text and readable structural markers are emitted. */
async function htmlToText(response: Response, url: URL, limit: number): Promise<string> {
  let output = ''
  let trailingWhitespace = ''
  let hidden = 0
  let pre = 0
  const append = (text: string) => {
    if (output.length > limit) return
    const normalized = output ? text : text.trimStart()
    const content = normalized.trimEnd()
    if (content) {
      output += (trailingWhitespace + content).slice(0, limit + 1 - output.length)
      trailingWhitespace = ''
    }
    trailingWhitespace = (trailingWhitespace + normalized.slice(content.length)).slice(0, limit + 1)
  }
  const rewriter = new HTMLRewriter()
    .on('*', {
      element(element) {
        const tag = element.tagName
        if (['script', 'style', 'nav', 'footer'].includes(tag)) {
          hidden++
          element.onEndTag(() => {
            hidden--
          })
          return
        }
        if (hidden) return
        let end = ''
        if (/^h[1-6]$/.test(tag)) {
          append(`\n\n${'#'.repeat(Number(tag[1]))} `)
          end = '\n\n'
        } else if (['p', 'div', 'section', 'article', 'ul', 'ol'].includes(tag)) {
          append('\n\n')
          end = '\n\n'
        } else if (tag === 'li') {
          append('\n- ')
          end = '\n'
        } else if (tag === 'br') {
          append('\n')
        } else if (tag === 'pre') {
          pre++
          append('\n\n```\n')
          end = '\n```\n\n'
        } else if (tag === 'code' && !pre) {
          append('`')
          end = '`'
        } else if (tag === 'a') {
          const href = element.getAttribute('href')
          if (href) {
            try {
              end = ` (${new URL(decodeEntities(href), url).href})`
            } catch {}
          }
        }
        if (end)
          element.onEndTag(() => {
            append(end)
            if (tag === 'pre') pre--
          })
      },
    })
    .onDocument({
      text(chunk) {
        if (!hidden) {
          const text = decodeEntities(chunk.text)
          append(pre ? text : text.replace(/\s+/g, ' '))
        }
      },
    })
  await rewriter.transform(response).text()
  return output
}

/** Read-only HTTP retrieval with per-host approval and per-hop network checks. */
export class WebFetchTool implements Tool<WebFetchInput, string> {
  name = 'WebFetch'
  description =
    'Fetch an http(s) URL as untrusted readable text. Requires approval per host. ' +
    'max_chars limits content (default 50000, maximum 200000), excluding the source label and truncation footer.'
  inputSchema = inputSchema

  constructor(private readonly options: WebFetchOptions = {}) {}

  isReadOnly(): boolean {
    return true
  }

  // Even a read-only request can pause for approval, including on redirects.
  isConcurrencySafe(): boolean {
    return false
  }

  async call(input: WebFetchInput, ctx: ToolContext): Promise<ToolResult<string>> {
    const timeout = new AbortController()
    const signal = ctx.abortSignal
      ? AbortSignal.any([ctx.abortSignal, timeout.signal])
      : timeout.signal
    let remainingMs = this.options.timeoutMs ?? 30_000
    // One cumulative deadline for DNS, redirects and body reads; human approval time is excluded.
    const timed = async <T>(operation: () => Promise<T>): Promise<T> => {
      signal.throwIfAborted()
      const started = performance.now()
      const timer = setTimeout(() => timeout.abort(), Math.max(0, remainingMs))
      try {
        return await abortable(operation(), signal)
      } finally {
        clearTimeout(timer)
        remainingMs -= performance.now() - started
      }
    }
    try {
      let current = new URL(input.url)
      const maxChars = input.max_chars ?? 50_000
      const approvedHosts = new Set<string>()
      const resolve =
        this.options.resolve ??
        (async (host: string) => (await lookup(host, { all: true })).map(({ address }) => address))
      const privateCheck = this.options.isPrivateAddress ?? isPrivateAddress
      for (let redirects = 0; ; redirects++) {
        signal.throwIfAborted()
        if (!['http:', 'https:'].includes(current.protocol)) {
          throw new Error('invalid_url: Only http and https URLs are supported.')
        }
        const hostname = current.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
        const addresses = await timed(() =>
          isIP(hostname) ? Promise.resolve([hostname]) : resolve(hostname),
        )
        if (addresses.length === 0 || addresses.some((address) => !isIP(address))) {
          throw new Error('dns_error: Host did not resolve to an IP address.')
        }
        // Fake-IP DNS proxies route this pool through a TUN and resolve the real destination
        // upstream. For hostname-only answers entirely in the pool, trust that proxy: the
        // local SSRF check cannot inspect the real target. Literals and mixed answers stay blocked.
        const fakeIpHost =
          !isIP(hostname) &&
          addresses.every((address) => {
            const ipv4 = embeddedIPv4(address)
            return ipv4 !== undefined && fakeIpAddresses.check(ipv4, 'ipv4')
          })
        if (
          !ctx.config?.webFetch?.allowPrivateNetwork &&
          (hostname === 'localhost' ||
            hostname.endsWith('.localhost') ||
            (!fakeIpHost && addresses.some((address) => privateCheck(address, hostname))))
        ) {
          throw new Error(`private_network: Refusing private or metadata target ${hostname}.`)
        }
        signal.throwIfAborted()
        if (!approvedHosts.has(hostname)) {
          const decision = await requestPermission(this.name, { url: current.href }, ctx)
          signal.throwIfAborted()
          if (decision === 'deny') {
            return { ok: false, error: 'permission_denied: User denied execution.' }
          }
          approvedHosts.add(hostname)
        }
        // Pin the connection to a checked answer, preventing a second DNS lookup/rebinding.
        const target = new URL(current)
        const address = addresses[0] as string
        target.hostname = isIP(address) === 6 ? `[${address}]` : address
        const options = {
          redirect: 'manual' as const,
          signal,
          headers: { Host: current.host },
          proxy: false,
          tls: { serverName: hostname, rejectUnauthorized: true },
        }
        const response = await timed(() => fetch(target, options))
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel()
          if (redirects >= 5) throw new Error('too_many_redirects: Limit is 5 redirects.')
          const location = response.headers.get('location')
          if (!location) throw new Error('redirect_error: Missing Location header.')
          current = new URL(location, current)
          continue
        }
        if (!response.ok) {
          await response.body?.cancel()
          throw new Error(`http_error: HTTP ${response.status} ${response.statusText}`)
        }
        const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
        const html = type === 'text/html' || type === 'application/xhtml+xml'
        if (
          !type.startsWith('text/') &&
          !html &&
          !/^application\/(?:json|xml|javascript|x-javascript|x-www-form-urlencoded|[\w.+-]+\+(?:json|xml))$/.test(
            type,
          )
        ) {
          await response.body?.cancel()
          throw new Error(`binary_content: Unsupported content type ${type || '(missing)'}.`)
        }
        const text = await timed(() =>
          html ? htmlToText(response, current, maxChars) : response.text(),
        )
        const footer =
          text.length > maxChars ? `\n[Content truncated at ${maxChars} characters]` : ''
        return {
          ok: true,
          value: `[Untrusted web content from ${current.href}]\n${text.slice(0, maxChars)}${footer}`,
        }
      }
    } catch (error) {
      if (ctx.abortSignal?.aborted) return { ok: false, error: 'aborted: WebFetch cancelled.' }
      if (timeout.signal.aborted)
        return { ok: false, error: 'timeout: WebFetch exceeded its 30s timeout.' }
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

export const webFetchTool = new WebFetchTool()
