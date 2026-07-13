// biome-ignore lint/suspicious/noExplicitAny: Bun globals are provided by the runtime.
declare const Bun: any

import { createHash } from 'node:crypto'
import readline from 'node:readline'
import { READ_ONLY_FORK_SKILL_TOOLS } from '../skills/execute'
import { globTool } from '../tools/Glob'
import { grepTool } from '../tools/Grep'
import { readTool } from '../tools/Read'
import type { Tool } from '../tools/Tool'
import { type ForkResult, type PreparedFork, getForkDepth } from './fork'
import { getProvider } from './index'
import type {
  CanonicalMessage,
  CanonicalTool,
  ContentBlock,
  LLMProvider,
  StreamEvent,
  Usage,
} from './types'

const DEFAULT_FORK_MAX_TOKENS = 4096
const FORK_PURPOSES = new Set([
  'compact',
  'memory_extract',
  'memory_recall',
  'skill',
  'tool_summary',
  'agent',
])

export const MAX_FORK_PENDING_MESSAGES = 16

export interface ForkMessageChannel {
  drain(): string[]
}

interface ForkMockConfig {
  text?: string
  delayMs?: number
  scriptedEvents?: StreamEvent[][]
  validatePairing?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!isRecord(value) || typeof value.type !== 'string') return false

  if (value.type === 'text') return typeof value.text === 'string'
  if (value.type === 'tool_use') {
    return typeof value.id === 'string' && typeof value.name === 'string' && 'input' in value
  }
  if (value.type === 'tool_result') {
    return (
      typeof value.tool_use_id === 'string' &&
      typeof value.content === 'string' &&
      (value.is_error === undefined || typeof value.is_error === 'boolean')
    )
  }
  return false
}

function isContent(value: unknown): value is string | ContentBlock[] {
  return typeof value === 'string' || (Array.isArray(value) && value.every(isContentBlock))
}

function isCanonicalMessage(value: unknown): value is CanonicalMessage {
  if (!isRecord(value) || typeof value.role !== 'string') return false

  if (value.role === 'user') return isContent(value.content)
  if (value.role === 'assistant') {
    return Array.isArray(value.content) && value.content.every(isContentBlock)
  }
  if (value.role === 'tool') {
    return typeof value.tool_use_id === 'string' && isContent(value.content)
  }
  return false
}

function isCanonicalTool(value: unknown): value is CanonicalTool {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    isRecord(value.inputSchema)
  )
}

function isPreparedFork(value: unknown): value is PreparedFork {
  if (!isRecord(value) || !isRecord(value.budget)) return false

  const maxTokens = value.budget.maxTokens
  return (
    typeof value.systemPrompt === 'string' &&
    typeof value.repoRoot === 'string' &&
    value.repoRoot.length > 0 &&
    Array.isArray(value.messages) &&
    value.messages.every(isCanonicalMessage) &&
    Array.isArray(value.tools) &&
    value.tools.every(isCanonicalTool) &&
    isStringRecord(value.childEnv) &&
    Number.isInteger(value.budget.maxTurns) &&
    (value.budget.maxTurns as number) > 0 &&
    (maxTokens === undefined || (typeof maxTokens === 'number' && Number.isFinite(maxTokens))) &&
    typeof value.purpose === 'string' &&
    FORK_PURPOSES.has(value.purpose) &&
    typeof value.model === 'string'
  )
}

function parsePreparedFork(input: string): PreparedFork {
  const parsed: unknown = JSON.parse(input)
  if (!isPreparedFork(parsed)) {
    throw new TypeError('Invalid fork payload')
  }
  return parsed
}

function parseMockConfig(raw: string): ForkMockConfig {
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) {
    throw new TypeError('OCTONOESIS_FORK_MOCK must contain an object')
  }
  if (
    parsed.delayMs !== undefined &&
    (typeof parsed.delayMs !== 'number' || !Number.isFinite(parsed.delayMs) || parsed.delayMs < 0)
  ) {
    throw new TypeError('OCTONOESIS_FORK_MOCK delayMs must be a non-negative number')
  }
  let scriptedEvents: StreamEvent[][] | undefined
  if (parsed.scriptedEvents !== undefined) {
    if (
      !Array.isArray(parsed.scriptedEvents) ||
      !parsed.scriptedEvents.every(
        (turn) => Array.isArray(turn) && turn.every((event) => isMockStreamEvent(event)),
      )
    ) {
      throw new TypeError('OCTONOESIS_FORK_MOCK scriptedEvents must be valid event turns')
    }
    scriptedEvents = parsed.scriptedEvents as StreamEvent[][]
  }
  if (typeof parsed.text !== 'string' && scriptedEvents === undefined) {
    throw new TypeError('OCTONOESIS_FORK_MOCK must contain a string text field')
  }
  if (parsed.validatePairing !== undefined && typeof parsed.validatePairing !== 'boolean') {
    throw new TypeError('OCTONOESIS_FORK_MOCK validatePairing must be a boolean')
  }
  return {
    ...(typeof parsed.text === 'string' ? { text: parsed.text } : {}),
    ...(parsed.delayMs === undefined ? {} : { delayMs: parsed.delayMs }),
    ...(scriptedEvents === undefined ? {} : { scriptedEvents }),
    ...(parsed.validatePairing === undefined ? {} : { validatePairing: parsed.validatePairing }),
  }
}

function assertToolUsePairing(messages: CanonicalMessage[]): void {
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'assistant') continue
    const laterToolResultIds = new Set(
      messages
        .slice(index + 1)
        .filter((candidate) => candidate.role === 'tool')
        .map((candidate) => (candidate.role === 'tool' ? candidate.tool_use_id : '')),
    )
    const dangling = message.content.find(
      (block) => block.type === 'tool_use' && !laterToolResultIds.has(block.id),
    )
    if (dangling?.type === 'tool_use') {
      const error = new Error(
        `400 invalid_request_error: tool_use id ${dangling.id} has no following tool_result`,
      ) as Error & { status: number; type: string }
      error.status = 400
      error.type = 'invalid_request_error'
      throw error
    }
  }
}

function isMockStreamEvent(value: unknown): value is StreamEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'text_delta') return typeof value.text === 'string'
  if (value.type === 'tool_use') {
    return typeof value.id === 'string' && typeof value.name === 'string' && 'input' in value
  }
  return (
    value.type === 'message_end' &&
    isRecord(value.usage) &&
    typeof value.usage.input_tokens === 'number' &&
    typeof value.usage.output_tokens === 'number'
  )
}

function waitForMockDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Fork child aborted'))
      return
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }, delayMs)
    const handleAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', handleAbort)
      reject(signal.reason ?? new Error('Fork child aborted'))
    }
    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

/**
 * Test-only provider selected by OCTONOESIS_FORK_MOCK. It keeps process-boundary tests
 * deterministic and keyless while exercising the real child loop.
 */
function createMockProvider(config: ForkMockConfig): LLMProvider {
  let turn = 0
  return {
    name: 'anthropic',
    async *createMessageStream(
      messages: CanonicalMessage[],
      _tools,
      opts,
    ): AsyncIterable<StreamEvent> {
      if (config.validatePairing) assertToolUsePairing(messages)
      if (config.delayMs !== undefined) {
        await waitForMockDelay(config.delayMs, opts.signal)
      }
      if (opts.signal.aborted) return

      const scripted = config.scriptedEvents?.[turn++]
      if (scripted) {
        const latestTool = [...messages].reverse().find((message) => message.role === 'tool')
        const latestToolText =
          latestTool?.role === 'tool'
            ? typeof latestTool.content === 'string'
              ? latestTool.content
              : latestTool.content
                  .map((block) =>
                    block.type === 'text'
                      ? block.text
                      : block.type === 'tool_result'
                        ? block.content
                        : '',
                  )
                  .join('')
            : ''
        const latestToolIsError =
          latestTool?.role === 'tool' && Array.isArray(latestTool.content)
            ? latestTool.content.some(
                (block) => block.type === 'tool_result' && block.is_error === true,
              )
            : false
        const latestUser = [...messages].reverse().find((message) => message.role === 'user')
        const latestUserText =
          latestUser?.role === 'user'
            ? typeof latestUser.content === 'string'
              ? latestUser.content
              : latestUser.content
                  .map((block) => (block.type === 'text' ? block.text : ''))
                  .join('')
            : ''
        for (const event of scripted) {
          yield event.type === 'text_delta'
            ? {
                ...event,
                text: event.text
                  .replaceAll('{{tool_result}}', latestToolText)
                  .replaceAll('{{tool_is_error}}', String(latestToolIsError))
                  .replaceAll('{{latest_user}}', latestUserText),
              }
            : event
        }
        return
      }
      yield { type: 'text_delta', text: config.text ?? '' }
      yield {
        type: 'message_end',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    },
  }
}

function getChildProvider(): LLMProvider {
  const mockConfig = process.env.OCTONOESIS_FORK_MOCK
  return mockConfig === undefined ? getProvider() : createMockProvider(parseMockConfig(mockConfig))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function appendTextBlock(content: ContentBlock[], text: string): void {
  const lastBlock = content[content.length - 1]
  if (lastBlock?.type === 'text') {
    lastBlock.text += text
  } else {
    content.push({ type: 'text', text })
  }
}

const readOnlyForkTools = new Map<string, Tool>([
  [readTool.name, readTool],
  [grepTool.name, grepTool],
  [globTool.name, globTool],
])

async function executeReadOnlyToolUses(
  prepared: PreparedFork,
  assistantContent: ContentBlock[],
  messages: CanonicalMessage[],
  signal: AbortSignal,
): Promise<void> {
  const preparedNames = new Set(prepared.tools.map((tool) => tool.name))
  const safeNames = new Set<string>(READ_ONLY_FORK_SKILL_TOOLS)
  for (const block of assistantContent) {
    if (block.type !== 'tool_use') continue
    const tool = readOnlyForkTools.get(block.name)
    let content: string
    let isError = false
    if (!preparedNames.has(block.name) || !safeNames.has(block.name) || !tool) {
      content = `Tool ${block.name} is not available to this ${prepared.purpose} fork.`
      isError = true
    } else if (!tool.isReadOnly(block.input)) {
      content = `Tool ${block.name} was refused because it is not read-only.`
      isError = true
    } else {
      const parsed = tool.inputSchema.safeParse(block.input)
      if (!parsed.success) {
        content = `Invalid ${block.name} input: ${parsed.error.message}`
        isError = true
      } else {
        const result = await tool.call(parsed.data, {
          repoRoot: prepared.repoRoot,
          abortSignal: signal,
        })
        content = result.ok
          ? typeof result.value === 'string'
            ? result.value
            : JSON.stringify(result.value)
          : result.error
        isError = !result.ok
      }
    }
    messages.push({
      role: 'tool',
      tool_use_id: block.id,
      content: isError
        ? [
            { type: 'tool_result', tool_use_id: block.id, content, is_error: true },
            { type: 'text', text: content },
          ]
        : content,
    })
  }
}

export function hasReachedMaxTurns(turn: number, maxTurns: number): boolean {
  return turn >= maxTurns
}

export async function runForkLoop(
  prepared: PreparedFork,
  provider: LLMProvider,
  signal: AbortSignal,
  messageChannel?: ForkMessageChannel,
): Promise<ForkResult> {
  const messages = structuredClone(prepared.messages)
  const usage: Usage = { input_tokens: 0, output_tokens: 0 }
  const systemPromptSha256 = createHash('sha256').update(prepared.systemPrompt).digest('hex')
  let turns = 0
  let text = ''

  while (!hasReachedMaxTurns(turns, prepared.budget.maxTurns)) {
    for (const message of messageChannel?.drain() ?? []) {
      messages.push({ role: 'user', content: message })
    }
    turns++
    const assistantContent: ContentBlock[] = []
    let sawToolUse = false

    try {
      const stream = provider.createMessageStream(messages, prepared.tools, {
        model: prepared.model,
        maxTokens: prepared.budget.maxTokens ?? DEFAULT_FORK_MAX_TOKENS,
        signal,
        system: prepared.systemPrompt,
      })

      for await (const event of stream) {
        if (event.type === 'text_delta') {
          text += event.text
          appendTextBlock(assistantContent, event.text)
        } else if (event.type === 'tool_use') {
          sawToolUse = true
          assistantContent.push({
            type: 'tool_use',
            id: event.id,
            name: event.name,
            input: event.input,
          })
        } else {
          usage.input_tokens += event.usage.input_tokens
          usage.output_tokens += event.usage.output_tokens
        }
      }
    } catch (error) {
      if (signal.aborted) {
        return {
          text,
          usage,
          turns,
          exitReason: 'user_cancel',
          error: 'Fork child aborted',
          systemPromptSha256,
        }
      }
      return {
        text,
        usage,
        turns,
        exitReason: 'fatal_error',
        error: errorMessage(error),
        systemPromptSha256,
      }
    }

    if (signal.aborted) {
      return {
        text,
        usage,
        turns,
        exitReason: 'user_cancel',
        error: 'Fork child aborted',
        systemPromptSha256,
      }
    }

    messages.push({ role: 'assistant', content: assistantContent })

    if (!sawToolUse) {
      return { text, usage, turns, exitReason: 'completed', systemPromptSha256 }
    }

    if (prepared.purpose !== 'skill' && prepared.purpose !== 'agent') {
      // Non-tool forks deliberately have no child execution loop. Drain the response
      // for accounting and preserve their historical stop behavior.
      return { text, usage, turns, exitReason: 'completed', systemPromptSha256 }
    }
    await executeReadOnlyToolUses(prepared, assistantContent, messages, signal)
  }

  return { text, usage, turns, exitReason: 'max_turns', systemPromptSha256 }
}

export async function forkChildMain(): Promise<number> {
  try {
    if (getForkDepth() > 1) {
      throw new Error('Fork child depth exceeds the maximum of 1')
    }

    const input = readline.createInterface({ input: process.stdin })
    const iterator = input[Symbol.asyncIterator]()
    const firstLine = await iterator.next()
    if (firstLine.done) throw new TypeError('Fork child stdin was empty')
    const prepared = parsePreparedFork(firstLine.value)
    const pending: string[] = []
    const messageChannel: ForkMessageChannel = {
      drain() {
        return pending.splice(0, pending.length)
      },
    }
    if (prepared.purpose === 'agent') {
      void (async () => {
        try {
          for await (const line of iterator) {
            try {
              const control: unknown = JSON.parse(line)
              if (
                !isRecord(control) ||
                control.type !== 'message' ||
                typeof control.text !== 'string'
              ) {
                throw new TypeError('invalid message control line')
              }
              if (pending.length >= MAX_FORK_PENDING_MESSAGES) {
                console.error('Fork child message queue full; message skipped')
                continue
              }
              pending.push(control.text)
            } catch (error) {
              console.error(`Fork child skipped invalid control line: ${errorMessage(error)}`)
            }
          }
        } catch (error) {
          console.error(`Fork child message channel failed: ${errorMessage(error)}`)
        }
      })()
    }
    const controller = new AbortController()
    const handleTermination = () => controller.abort(new Error('Fork child terminated'))
    process.once('SIGTERM', handleTermination)
    process.once('SIGINT', handleTermination)

    try {
      const result = await runForkLoop(
        prepared,
        getChildProvider(),
        controller.signal,
        prepared.purpose === 'agent' ? messageChannel : undefined,
      )
      await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`)
      return 0
    } finally {
      process.removeListener('SIGTERM', handleTermination)
      process.removeListener('SIGINT', handleTermination)
    }
  } catch (error) {
    console.error(`Fork child error: ${errorMessage(error)}`)
    return 1
  }
}
