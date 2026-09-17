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

/**
 * Checks whether an unknown value is a non-null object record.
 * @param value The value to inspect.
 * @returns True if value is a record object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Checks whether an unknown value is a record where all values are strings.
 * @param value The value to inspect.
 * @returns True if value is a string record.
 */
function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')
}

/**
 * Validates whether a value conforms to the ContentBlock schema.
 * @param value The value to inspect.
 * @returns True if value is a valid ContentBlock.
 */
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

/**
 * Validates whether a value is a valid message content payload (string or ContentBlock array).
 * @param value The value to inspect.
 * @returns True if value is valid message content.
 */
function isContent(value: unknown): value is string | ContentBlock[] {
  return typeof value === 'string' || (Array.isArray(value) && value.every(isContentBlock))
}

/**
 * Validates whether an object conforms to the CanonicalMessage structure.
 * @param value The value to inspect.
 * @returns True if value is a CanonicalMessage.
 */
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

/**
 * Validates whether an object conforms to CanonicalTool schema.
 * @param value The value to inspect.
 * @returns True if value is a CanonicalTool.
 */
function isCanonicalTool(value: unknown): value is CanonicalTool {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    isRecord(value.inputSchema)
  )
}

/**
 * Validates whether a deserialized object is a complete PreparedFork.
 * @param value The value to inspect.
 * @returns True if value is a PreparedFork.
 */
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

/**
 * Parses and validates the fork payload JSON string read from child stdin.
 * @param input Raw stdin JSON string.
 * @returns Validated PreparedFork instance.
 * @throws {TypeError} If the payload cannot be parsed or fails validation.
 */
function parsePreparedFork(input: string): PreparedFork {
  const parsed: unknown = JSON.parse(input)
  if (!isPreparedFork(parsed)) {
    throw new TypeError('Invalid fork payload')
  }
  return parsed
}

/**
 * Parses the OCTONOESIS_FORK_MOCK environment variable string into a structured ForkMockConfig.
 * @param raw Raw JSON string from OCTONOESIS_FORK_MOCK.
 * @returns The parsed ForkMockConfig.
 * @throws {TypeError} If the JSON or schema is invalid.
 */
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

/**
 * Verifies that every assistant tool_use block in the message history is followed by a tool_result.
 * Throws a simulated Anthropic 400 error if any dangling tool_use is detected.
 * @param messages The canonical message array to validate.
 * @throws {Error & { status: 400 }} If an unpaired tool_use is found.
 */
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

/**
 * Type guard for validating mock StreamEvent objects.
 * @param value The value to inspect.
 * @returns True if value is a valid StreamEvent.
 */
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

/**
 * Delays execution for mock testing, respecting cancellation from an AbortSignal.
 * @param delayMs Delay duration in milliseconds.
 * @param signal AbortSignal to interrupt the delay.
 * @returns Promise that resolves when delay elapses.
 */
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
 * @param config Mock configuration specifying scripted events or text.
 * @returns An LLMProvider instance.
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

/**
 * Resolves the LLM provider for the fork child, preferring mock providers when OCTONOESIS_FORK_MOCK is set.
 * @returns The active LLMProvider instance.
 */
function getChildProvider(): LLMProvider {
  const mockConfig = process.env.OCTONOESIS_FORK_MOCK
  return mockConfig === undefined ? getProvider() : createMockProvider(parseMockConfig(mockConfig))
}

/**
 * Extracts a formatted error message string from an unknown error value.
 * @param error The error value.
 * @returns The extracted error message.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Appends streaming text to the last block in content if it is a text block, or pushes a new text block.
 * @param content The ContentBlock array to mutate.
 * @param text The new text string to append.
 */
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

/**
 * Executes read-only tool calls (Read, Grep, Glob) requested by the fork assistant.
 * Strictly enforces that tools are read-only and allowed for the fork purpose.
 * @param prepared Prepared fork parameters.
 * @param assistantContent Content blocks from the assistant containing tool_use blocks.
 * @param messages The conversation message array to which tool_result blocks are appended.
 * @param signal AbortSignal for cancellation.
 */
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

/**
 * Checks whether the current loop turn has reached or exceeded maxTurns.
 * @param turn Current turn count.
 * @param maxTurns Maximum turns allowed.
 * @returns True if max turns reached.
 */
export function hasReachedMaxTurns(turn: number, maxTurns: number): boolean {
  return turn >= maxTurns
}

/**
 * Runs the fork child agent query loop, executing provider requests and read-only tools until completion or turn limit.
 * @param prepared Validated fork specifications.
 * @param provider LLMProvider instance.
 * @param signal AbortSignal for cancellation.
 * @param messageChannel Optional incoming message channel for interactive sub-agents.
 * @returns The final ForkResult.
 */
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

/**
 * Main entry point for the fork child process spawned via `--fork-child`.
 * Reads stdin, runs the fork loop, outputs the JSON result to stdout, and exits.
 * @returns Exit code (0 on success, 1 on error).
 */
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
