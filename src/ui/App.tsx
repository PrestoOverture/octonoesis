import crypto from 'node:crypto'
import { Box, Static, Text, useApp, useInput, useWindowSize } from 'ink'
import React, { useState, useEffect, useRef, useReducer } from 'react'
import { registerPromptHandler, unregisterPromptHandler } from '../permissions/confirm'
import { getResolvedModel } from '../providers'
import {
  type CanonicalMessage,
  type QueryResult,
  type ToolContext,
  formatQueryFailure,
  query,
} from '../query'
import type { SessionState } from '../query/types'
import type { ResolvedSandboxConfig } from '../sandbox/types'
import { rewriteSkillSlashCommand } from '../skills/execute'
import { createSessionState } from '../state/session'
import { estimateCost } from '../utils/cost'
import { dbg } from '../utils/debug'
import { getMemoryDir, getRepoRoot } from '../utils/path'
import { CompactNotice } from './CompactNotice'
import { ConfirmDialog } from './ConfirmDialog'
import { PromptInput } from './PromptInput'
import { StatusBar } from './StatusBar'
import { TaskChip } from './TaskChip'
import { TodoPanel } from './TodoPanel'
import { ToolCard } from './ToolCard'
import { appendInputHistory, loadInputHistory } from './inputHistory'
import { renderMarkdown } from './markdown'
import { type DisplayItem, seedTranscript, transcriptReducer } from './transcript'
export type { CanonicalMessage } from '../query'

/**
 * Props for the root TUI application component.
 */
export interface AppProps {
  messages?: CanonicalMessage[]
  streamingText?: string
  streamingToolUses?: { name: string; status?: 'running' | 'done' | 'error'; input?: unknown }[]
  placeholder?: string
  sandbox?: ResolvedSandboxConfig
  ctx?: ToolContext
  onSessionState?: (sessionState: SessionState, priced: boolean) => void
  resumeInfo?: {
    sessionId: string
    messageCount: number
    updatedAt: string
  }
}

const TASK_NOTICE_PREFIX = '<task-notification>'
const TASK_NOTICE_GENERIC_LABEL = 'Task › background task update'
const TASK_NOTICE_SUMMARY_MAX_CHARS = 80

/**
 * Extracts a single known tag's inner text from an XML task notification.
 *
 * @param source - Raw XML notification string
 * @param tag - XML tag name to extract
 * @returns Trimmed tag content, or undefined if not matched
 */
function extractTaskNoticeTag(source: string, tag: string): string | undefined {
  const match = source.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))
  return match?.[1]?.trim()
}

/**
 * Collapses whitespace to a single line and truncates text to at most maxChars with an ellipsis.
 *
 * @param text - Raw summary string
 * @param maxChars - Maximum allowed character length (defaults to 80)
 * @returns Truncated single-line summary string
 */
function truncateTaskNoticeSummary(
  text: string,
  maxChars: number = TASK_NOTICE_SUMMARY_MAX_CHARS,
): string {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= maxChars) return singleLine
  return `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`
}

/**
 * Formats a synthetic `<task-notification>` user message into a compact single-line label.
 *
 * @param text - Notification message content
 * @returns Formatted label for display in chat history, or generic label if malformed
 */
export function formatTaskNoticeLabel(text: string): string {
  if (!text.startsWith(TASK_NOTICE_PREFIX)) return TASK_NOTICE_GENERIC_LABEL
  const taskId = extractTaskNoticeTag(text, 'task_id')
  const status = extractTaskNoticeTag(text, 'status')
  const summary = extractTaskNoticeTag(text, 'summary')
  if (!taskId || !status || !summary) return TASK_NOTICE_GENERIC_LABEL
  return `Task › ${taskId} ${status}: ${truncateTaskNoticeSummary(summary)}`
}

export function DisplayEntry({ item }: { item: DisplayItem }) {
  if (item.kind === 'tool')
    return <ToolCard tool={item.name} args={item.args} status={item.status} />
  if (item.kind === 'compact') return <CompactNotice {...item} />
  if (item.kind === 'resume') return <Text color="yellow">{item.text}</Text>
  if (item.kind === 'task_notice')
    return (
      <Text color="yellow" dimColor>
        {formatTaskNoticeLabel(item.text)}
      </Text>
    )
  if (item.kind === 'user')
    return (
      <Text bold color="cyan">
        User › <Text color="white">{item.text}</Text>
      </Text>
    )
  if ('verbatim' in item)
    return (
      <Box flexDirection="column">
        {item.header ? (
          <Text bold color="green">
            Agent ›
          </Text>
        ) : null}
        <Text color="white">
          {item.verbatim ? item.text : renderMarkdown(item.text).replace(/\n+$/, '')}
        </Text>
      </Box>
    )
  return null
}

/** Stateless history renderer for display tests; App seeds its Static once instead. */
export function MessageList({ messages = [] }: { messages?: CanonicalMessage[] }) {
  return (
    <Box flexDirection="column">
      {seedTranscript(messages).transcript.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: immutable display order
        <DisplayEntry key={index} item={item} />
      ))}
    </Box>
  )
}

/**
 * StreamingResponse renders the actively streaming text response and running tools
 * from the current query turn.
 * @param props The props containing current text and running tool states.
 * @returns The rendered Box containing active streaming logs, or null if empty.
 */
export function StreamingResponse(props: {
  text?: string
  toolUses?: { name: string; status: 'running' | 'done' | 'error'; input?: unknown }[]
}) {
  const { text = '', toolUses = [] } = props
  if (!text && toolUses.length === 0) return null

  return (
    <Box flexDirection="column" marginY={0}>
      {text ? (
        <Box flexDirection="column">
          <Text bold color="green">
            Agent ›
          </Text>
          <Text color="white">{renderMarkdown(text).replace(/\n+$/, '')}</Text>
        </Box>
      ) : null}
      {toolUses.map((tool, idx) => {
        const argsStr = tool.input ? JSON.stringify(tool.input) : ''
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: indices are stable in terminal chat history
          <ToolCard key={idx} tool={tool.name} args={argsStr} status={tool.status} />
        )
      })}
    </Box>
  )
}

/**
 * App is the root React component of the terminal TUI.
 * It coordinates chat history state, input submissions, active streaming generator execution,
 * permission dialog triggers, and layout splitting with the todo sidebar panel.
 * @param props The initial props for starting the React TUI.
 * @returns The rendered main terminal viewport.
 */
export function App(props: AppProps) {
  const {
    messages: initialMessages = [],
    streamingText: initialStreamingText = '',
    streamingToolUses: initialStreamingToolUses = [],
    placeholder = 'Type a message...',
    sandbox,
    ctx: providedCtx,
    onSessionState,
    resumeInfo,
  } = props
  const [ctx] = useState<ToolContext>(() => {
    if (providedCtx) {
      providedCtx.messages ??= initialMessages
      providedCtx.memoryDir ??= getMemoryDir()
      return providedCtx
    }
    const sessionId = crypto.randomUUID()
    const model = getResolvedModel()
    return {
      repoRoot: getRepoRoot(),
      memoryDir: getMemoryDir(),
      messages: initialMessages,
      sessionId,
      sessionState: createSessionState(sessionId, model),
      sandbox,
    }
  })

  const [display, dispatch] = useReducer(transcriptReducer, undefined, () => ({
    ...seedTranscript(initialMessages.length ? initialMessages : ctx.messages, resumeInfo),
    pending: initialStreamingText,
    running: initialStreamingToolUses.map((tool, index) => ({
      id: `initial-${index}`,
      name: tool.name,
      args: tool.input ? JSON.stringify(tool.input) : '',
    })),
  }))
  const { rows, columns } = useWindowSize()
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const [isGenerating, setIsGenerating] = useState(false)
  const { exit } = useApp()
  const abortControllerRef = useRef<AbortController | null>(null)

  // Wire the key binding
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (isGenerating) {
        abortControllerRef.current?.abort()
      } else {
        exit()
      }
    }
  })

  // Permission dialog state
  /**
   * Pending interactive confirmation request for tool execution permission.
   */
  interface PendingConfirm {
    toolName: string
    input: unknown
    resolve: (decision: 'allow_once' | 'allow_always' | 'deny') => void
  }
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null)

  // Register prompt handler at mount, unregister at unmount
  useEffect(() => {
    registerPromptHandler((toolName, input, signal) => {
      return new Promise<'allow_once' | 'allow_always' | 'deny'>((resolve) => {
        let settled = false
        const settle = (decision: 'allow_once' | 'allow_always' | 'deny') => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', handleAbort)
          setPendingConfirm(null)
          resolve(decision)
        }
        const handleAbort = () => settle('deny')
        if (signal?.aborted) {
          handleAbort()
          return
        }
        signal?.addEventListener('abort', handleAbort, { once: true })
        setPendingConfirm({
          toolName,
          input,
          resolve: settle,
        })
      })
    })

    return () => {
      unregisterPromptHandler()
    }
  }, [])

  useEffect(() => {
    let active = true
    const memoryDir = ctx.memoryDir
    if (!memoryDir) return () => undefined
    loadInputHistory(memoryDir)
      .then((entries) => {
        if (active) {
          setInputHistory((current) => {
            const combined = [...entries.map((entry) => entry.text), ...current]
            return combined
              .filter((value, index) => index === 0 || value !== combined[index - 1])
              .slice(-500)
          })
        }
      })
      .catch((error) => dbg('ui', 'Failed to load input history', error))
    return () => {
      active = false
    }
  }, [ctx])

  const modelName = getResolvedModel()
  const initialPricing = estimateCost({ input_tokens: 0, output_tokens: 0 }, modelName)
  const [sessionView, setSessionView] = useState<{
    sessionState: SessionState
    priced: boolean
  } | null>(null)

  const handleSubmit = (value: string) => {
    if (!value.trim() || isGenerating) return

    setInputHistory((previous) =>
      previous[previous.length - 1] === value ? previous : [...previous, value].slice(-500),
    )
    if (ctx.memoryDir) {
      appendInputHistory(ctx.memoryDir, value).catch((error) =>
        dbg('ui', 'Failed to append input history', error),
      )
    }

    if (value.trim() === '/stats') {
      dispatch({ type: 'user', text: value })
      ;(async () => {
        try {
          const { readCalibrationRecords, aggregateCalibrationStats } = await import(
            '../memory/calibration/stats.ts'
          )
          const { formatStatsTable } = await import('../memory/calibration/format.ts')
          const records = await readCalibrationRecords()
          const statsList = aggregateCalibrationStats(records)
          const table = formatStatsTable(statsList)

          dispatch({ type: 'stats', text: table })
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          dispatch({ type: 'failure', text: `Failed to load stats: ${errMsg}` })
        }
      })()
      return
    }

    setIsGenerating(true)

    dispatch({ type: 'user', text: value })

    const controller = new AbortController()
    abortControllerRef.current = controller

    // Execute query loop asynchronously in the background
    ;(async () => {
      try {
        const rewrittenValue = await rewriteSkillSlashCommand(value, ctx.repoRoot)
        const generator = query(rewrittenValue, ctx, controller.signal)
        let queryResult: QueryResult
        while (true) {
          const step = await generator.next()
          if (step.done) {
            queryResult = step.value
            break
          }
          const event = step.value
          dispatch(event)
          if (event.type === 'session_state') {
            const sessionState = {
              ...event.sessionState,
              usage: { ...event.sessionState.usage },
            }
            setSessionView({ sessionState, priced: event.priced })
            onSessionState?.(sessionState, event.priced)
          }
        }

        dispatch({ type: 'end' })
        const failure = formatQueryFailure(queryResult)
        if (failure) dispatch({ type: 'failure', text: failure })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        dispatch({ type: 'end' })
        dispatch({ type: 'failure', text: `Query failed: ${detail}` })
      } finally {
        setIsGenerating(false)
        abortControllerRef.current = null
      }
    })()
  }
  // Leave one terminal row free: Ink clears when leaving an exactly full frame too.
  const height = Math.max(0, rows - 1)
  const controlHeight = pendingConfirm ? Math.min(10, Math.max(3, height - 8)) : 3
  const chromeHeight = controlHeight + 6
  const runningRows = Math.min(
    display.running.length,
    Math.max(0, height - chromeHeight - (display.pending ? 5 : 0)),
  )
  const headerRows = display.pending && display.header ? 1 : 0
  const dynamicChromeHeight = chromeHeight + runningRows + headerRows
  const tailLines = Math.max(3, rows - dynamicChromeHeight - 2)
  const preview = renderMarkdown(display.pending).replace(/\n+$/, '').split('\n')
  const hidden = Math.max(0, preview.length - tailLines)
  return (
    <Box flexDirection="column" width={columns}>
      <Static items={display.transcript}>
        {(item, index) => <DisplayEntry key={index} item={item} />}
      </Static>
      <Box flexDirection="column" maxHeight={height} overflow="hidden">
        <Box
          flexDirection="row"
          maxHeight={Math.max(0, height - chromeHeight)}
          overflow="hidden"
          flexShrink={0}
        >
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            {display.pending ? (
              <Box flexDirection="column" flexShrink={0}>
                {display.header ? (
                  <Text bold color="green">
                    Agent ›
                  </Text>
                ) : null}
                {hidden ? <Text dimColor>… {hidden} lines above</Text> : null}
                <Text wrap="truncate-end">{preview.slice(-tailLines).join('\n')}</Text>
              </Box>
            ) : null}
            <Box flexDirection="column" maxHeight={runningRows} overflow="hidden" flexShrink={0}>
              {display.running.map((tool) => (
                <Box key={tool.id} height={1} flexShrink={0} overflow="hidden">
                  <ToolCard tool={tool.name} args={tool.args} status="running" />
                </Box>
              ))}
            </Box>
          </Box>
          <TodoPanel maxRows={Math.max(0, height - chromeHeight)} />
        </Box>
        <Box flexDirection="column" maxHeight={controlHeight} overflow="hidden" flexShrink={0}>
          {pendingConfirm ? (
            <ConfirmDialog
              toolName={pendingConfirm.toolName}
              input={pendingConfirm.input}
              onResolve={pendingConfirm.resolve}
              maxHeight={controlHeight}
            />
          ) : (
            <PromptInput
              history={inputHistory}
              onSubmit={handleSubmit}
              placeholder={placeholder}
              isDisabled={isGenerating}
            />
          )}
        </Box>
        <Box flexDirection="column" maxHeight={5} overflow="hidden" flexShrink={0}>
          <StatusBar
            modelName={sessionView?.sessionState.model ?? modelName}
            inputTokens={sessionView?.sessionState.usage.input_tokens ?? 0}
            outputTokens={sessionView?.sessionState.usage.output_tokens ?? 0}
            costUsd={sessionView?.sessionState.costUsd ?? 0}
            priced={sessionView?.priced ?? initialPricing.priced}
            contextUtilization={sessionView?.sessionState.contextUtilization ?? 0}
          />
        </Box>
        <Box flexDirection="column" maxHeight={1} overflow="hidden" flexShrink={0}>
          <TaskChip ctx={ctx} />
        </Box>
      </Box>
    </Box>
  )
}
