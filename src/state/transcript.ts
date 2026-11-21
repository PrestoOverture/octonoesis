import crypto from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redactCredentials } from '../memory/fingerprint/scrub'
import type {
  CanonicalMessage,
  CanonicalTool,
  ContentBlock,
  StopReason,
  Usage,
} from '../providers/types'

/** Opt-in path for full main-loop transcripts (headless experiments only). */
export const TRANSCRIPT_FILE_ENV = 'OCTONOESIS_TRANSCRIPT_FILE'

export const TRANSCRIPT_REPO_PLACEHOLDER = '/workspace/repo'
export const TRANSCRIPT_HOME_PLACEHOLDER = '/home/user'

const SECRET_ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SPARK_API_KEY'] as const

/** One provider request of the main query loop and the response the engine kept. */
export interface TranscriptExchange {
  model: string
  system?: string
  dynamicSystem?: string
  tools: CanonicalTool[]
  messages: CanonicalMessage[]
  response: ContentBlock[]
  stopReason: StopReason
  usage: Usage
  invalidToolCalls?: { id: string; name: string }[]
}

/**
 * Stored line. Messages are delta-encoded against the previous request:
 * `messages[i] = previous.messages[0..prefix) ++ append`. System prompt and tool
 * definitions are stored once and referenced by hash.
 */
export interface TranscriptLine {
  v: 1
  seq: number
  session_id?: string
  model: string
  system_sha?: string
  system?: string
  dynamic_system?: string
  tools_sha: string
  tools?: CanonicalTool[]
  prefix: number
  append: CanonicalMessage[]
  response: ContentBlock[]
  stop_reason: StopReason
  usage: Usage
  invalid_tool_calls?: { id: string; name: string }[]
}

export interface RedactOptions {
  repoRoot: string
  home?: string
  secrets?: string[]
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Builds a deterministic string redactor: literal secrets, credential patterns, local paths. */
export function createRedactor(options: RedactOptions): (text: string) => string {
  const secrets = (options.secrets ?? []).filter((s) => s.length >= 8)
  const roots: [RegExp, string][] = []
  const repo = options.repoRoot.replace(/\/+$/, '')
  const home = options.home?.replace(/\/+$/, '')
  // Longest first: the repo usually lives under the home directory.
  if (repo) roots.push([new RegExp(escapeRegex(repo), 'g'), TRANSCRIPT_REPO_PLACEHOLDER])
  if (home && home !== '/')
    roots.push([new RegExp(escapeRegex(home), 'g'), TRANSCRIPT_HOME_PLACEHOLDER])
  return (text) => {
    let out = text
    for (const secret of secrets) out = out.split(secret).join('[REDACTED]')
    out = redactCredentials(out)
    for (const [pattern, replacement] of roots) out = out.replace(pattern, replacement)
    return out
  }
}

/** Applies a string redactor to every string (keys and values) inside a JSON value. */
export function redactDeep<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[redact(key)] = redactDeep(item, redact)
    return out as T
  }
  return value
}

function sha(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** Delta-encodes successive exchanges into transcript lines (pure; used by the recorder and tests). */
export class TranscriptEncoder {
  private seq = 0
  private previous: string[] = []
  private readonly seenSystem = new Set<string>()
  private readonly seenTools = new Set<string>()

  constructor(
    private readonly redact: (text: string) => string,
    private readonly sessionId?: string,
  ) {}

  encode(exchange: TranscriptExchange): TranscriptLine {
    const clean = redactDeep(exchange, this.redact)
    const current = clean.messages.map((message) => JSON.stringify(message))
    let prefix = 0
    while (
      prefix < current.length &&
      prefix < this.previous.length &&
      current[prefix] === this.previous[prefix]
    )
      prefix++
    this.previous = current
    const toolsJson = JSON.stringify(clean.tools)
    const toolsSha = sha(toolsJson)
    const line: TranscriptLine = {
      v: 1,
      seq: this.seq++,
      ...(this.sessionId ? { session_id: this.sessionId } : {}),
      model: clean.model,
      tools_sha: toolsSha,
      prefix,
      append: clean.messages.slice(prefix),
      response: clean.response,
      stop_reason: clean.stopReason,
      usage: clean.usage,
      ...(clean.invalidToolCalls?.length ? { invalid_tool_calls: clean.invalidToolCalls } : {}),
    }
    if (clean.system !== undefined) {
      const systemSha = sha(clean.system)
      line.system_sha = systemSha
      if (!this.seenSystem.has(systemSha)) {
        this.seenSystem.add(systemSha)
        line.system = clean.system
      }
    }
    if (clean.dynamicSystem !== undefined) line.dynamic_system = clean.dynamicSystem
    if (!this.seenTools.has(toolsSha)) {
      this.seenTools.add(toolsSha)
      line.tools = clean.tools
    }
    return line
  }
}

/** Reconstructs the full (redacted) exchanges from stored lines, in order. */
export function replayTranscript(lines: TranscriptLine[]): TranscriptExchange[] {
  const systems = new Map<string, string>()
  const toolSets = new Map<string, CanonicalTool[]>()
  let previous: CanonicalMessage[] = []
  const out: TranscriptExchange[] = []
  for (const line of lines) {
    if (line.v !== 1) throw new Error(`Unsupported transcript version ${String(line.v)}`)
    if (line.prefix > previous.length) throw new Error(`Transcript line ${line.seq}: bad prefix`)
    if (line.system !== undefined && line.system_sha) systems.set(line.system_sha, line.system)
    if (line.tools) toolSets.set(line.tools_sha, line.tools)
    const tools = toolSets.get(line.tools_sha)
    if (!tools) throw new Error(`Transcript line ${line.seq}: unknown tools ${line.tools_sha}`)
    let system: string | undefined
    if (line.system_sha) {
      system = systems.get(line.system_sha)
      if (system === undefined) throw new Error(`Transcript line ${line.seq}: unknown system`)
    }
    const messages = [...previous.slice(0, line.prefix), ...line.append]
    previous = messages
    out.push({
      model: line.model,
      ...(system !== undefined ? { system } : {}),
      ...(line.dynamic_system !== undefined ? { dynamicSystem: line.dynamic_system } : {}),
      tools,
      messages,
      response: line.response,
      stopReason: line.stop_reason,
      usage: line.usage,
      ...(line.invalid_tool_calls ? { invalidToolCalls: line.invalid_tool_calls } : {}),
    })
  }
  return out
}

/** Parses a JSONL transcript file's text. */
export function parseTranscript(text: string): TranscriptLine[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TranscriptLine)
}

export interface TranscriptRecorder {
  record(exchange: TranscriptExchange): void
}

const recorders = new Map<string, TranscriptRecorder>()

/**
 * Returns the recorder for this process when `OCTONOESIS_TRANSCRIPT_FILE` is set, else undefined.
 * Recording failures never affect the session; they are reported once on stderr.
 */
export function getTranscriptRecorder(
  repoRoot: string,
  sessionId?: string,
  env: NodeJS.ProcessEnv = process.env,
): TranscriptRecorder | undefined {
  const file = env[TRANSCRIPT_FILE_ENV]
  if (!file) return undefined
  const key = `${file}\0${sessionId ?? ''}`
  const existing = recorders.get(key)
  if (existing) return existing
  const encoder = new TranscriptEncoder(
    createRedactor({
      repoRoot,
      home: os.homedir(),
      secrets: SECRET_ENV_KEYS.map((name) => env[name] ?? '').filter(Boolean),
    }),
    sessionId,
  )
  let warned = false
  const recorder: TranscriptRecorder = {
    record(exchange) {
      try {
        const line = encoder.encode(exchange)
        mkdirSync(path.dirname(file), { recursive: true })
        appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 })
      } catch (error) {
        if (!warned) {
          warned = true
          process.stderr.write(
            `Warning: transcript capture failed: ${error instanceof Error ? error.message : String(error)}\n`,
          )
        }
      }
    },
  }
  recorders.set(key, recorder)
  return recorder
}
