import crypto from 'node:crypto'
import { realpathSync } from 'node:fs'
import chalk from 'chalk'
import {
  Box,
  type DOMElement,
  Static,
  Text,
  measureElement,
  useApp,
  useBoxMetrics,
  useInput,
  useStdout,
  useWindowSize,
} from 'ink'
import React, { useState, useLayoutEffect, useEffect, useRef, useReducer } from 'react'
import { loadFitnessInput } from '../memory/fitness/io'
import { registerPromptHandler, unregisterPromptHandler } from '../permissions/confirm'
import { getResolvedModel } from '../providers'
import {
  type CanonicalMessage,
  type QueryResult,
  type ToolContext,
  formatQueryFailure,
  query,
} from '../query'
import { primaryArg } from '../query/toolSummary'
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
import { Spinner } from './Spinner'
import { Banner, type BannerSnapshot, StartupBanner } from './StartupBanner'
import { StatusBar } from './StatusBar'
import { TaskChip } from './TaskChip'
import { TodoPanel } from './TodoPanel'
import { ToolCard } from './ToolCard'
import { bannerLayout, bannerLines, fitnessLines } from './banner'
import { appendInputHistory, loadInputHistory } from './inputHistory'
import { renderMarkdown } from './markdown'
import { COMPACT_SIZE, createFrames } from './mascot'
import { type DisplayItem, seedTranscript, transcriptReducer } from './transcript'
import { useResizeReset } from './useResizeReset'
import { wrapAssistant } from './wrapAssistant'
export type { CanonicalMessage } from '../query'

/**
 * Props for the root TUI application component.
 */
export interface AppProps {
  shutdownSignal?: AbortSignal
  onQuery?: (completion: Promise<void>) => void
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

export function DisplayEntry({ item, width }: { item: DisplayItem; width?: number }) {
  if (item.kind === 'banner') return <Banner {...item} />
  if (item.kind === 'tool')
    return (
      <ToolCard
        width={width}
        tool={item.name}
        args={item.args}
        status={item.status}
        summary={item.summary}
      />
    )
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
      <Box flexDirection="column">
        {item.spacer ? <Text> </Text> : null}
        <Text>
          <Text color="cyan">❯ </Text>
          <Text color="white">{item.text}</Text>
        </Text>
      </Box>
    )
  if ('verbatim' in item)
    return (
      <Box flexDirection="column">
        {item.header ? <Text> </Text> : null}
        <Text color="white">
          {item.verbatim
            ? item.text
            : width === undefined
              ? renderMarkdown(item.text).replace(/\n+$/, '')
              : wrapAssistant(renderMarkdown(item.text).replace(/\n+$/, ''), width)}
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
          <Text> </Text>
          <Text color="white">{renderMarkdown(text).replace(/\n+$/, '')}</Text>
        </Box>
      ) : null}
      {toolUses.map((tool, idx) => {
        const argsStr = primaryArg(tool.name, tool.input)
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

  const [repoRoots] = useState(() => {
    try {
      return [ctx.repoRoot, realpathSync(ctx.repoRoot)]
    } catch {
      return [ctx.repoRoot]
    }
  })
  const parentRef = useRef<DOMElement>(null)
  const parentMetrics = useBoxMetrics(parentRef)
  const contentRef = useRef<DOMElement>(null)
  const contentMetrics = useBoxMetrics(contentRef)
  const transcriptWidth = Math.max(1, parentMetrics.width - 1)
  const { rows, columns } = useWindowSize()
  const resizing = useResizeReset()
  const [statusHeight, setStatusHeight] = useState(1)
  const [inputHeight, setInputHeight] = useState(3)
  const [isGenerating, setIsGenerating] = useState(false)
  const statusRef = useRef<DOMElement>(null)
  useLayoutEffect(() => {
    if (statusRef.current) setStatusHeight(measureElement(statusRef.current).height)
  })
  const { stdout } = useStdout()
  const [frames] = useState(() => createFrames(chalk, true))
  const [fitness, setFitness] = useState<string[]>([])
  const [bannerCommitted, setBannerCommitted] = useState(() =>
    Boolean(resumeInfo || initialMessages.length || ctx.messages?.length),
  )
  const lines = bannerLines(ctx.sessionState?.model ?? getResolvedModel(), ctx.repoRoot, fitness)
  const layout = bannerLayout(
    columns,
    rows,
    lines.length,
    process.env.NO_COLOR === undefined && chalk.level > 0,
    inputHeight + statusHeight + 1 + (isGenerating ? 1 : 0),
  )
  const banner: BannerSnapshot = {
    lines,
    layout,
    mascot: layout === 'text' ? undefined : frames[1],
  }
  useEffect(() => {
    if (bannerCommitted || !ctx.memoryDir) return
    let active = true
    loadFitnessInput(ctx.memoryDir)
      .then((input) => {
        if (active) setFitness(fitnessLines(input))
      })
      .catch((error) => dbg('ui', 'Failed to load banner fitness', error))
    return () => {
      active = false
    }
  }, [ctx.memoryDir, bannerCommitted])

  const [display, dispatch] = useReducer(
    (state: ReturnType<typeof seedTranscript>, event: Parameters<typeof transcriptReducer>[1]) =>
      transcriptReducer(state, event, repoRoots),
    undefined,
    () => {
      const seeded = seedTranscript(
        initialMessages.length ? initialMessages : ctx.messages,
        resumeInfo,
        repoRoots,
      )
      return {
        ...seeded,
        transcript: [
          ...(bannerCommitted ? [{ kind: 'banner' as const, ...banner }] : []),
          ...seeded.transcript,
        ],
        pending: initialStreamingText,
        running: initialStreamingToolUses.map((tool, index) => ({
          id: `initial-${index}`,
          name: tool.name,
          args: primaryArg(tool.name, tool.input, repoRoots),
        })),
      }
    },
  )
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const generationStarted = useRef(0)
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

    if (!bannerCommitted) {
      dispatch({ type: 'banner', snapshot: banner })
      setBannerCommitted(true)
    }
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

    generationStarted.current = Date.now()
    setIsGenerating(true)

    dispatch({ type: 'user', text: value })

    const controller = new AbortController()
    abortControllerRef.current = controller

    // Execute query loop asynchronously in the background
    const completion = (async () => {
      try {
        const rewrittenValue = await rewriteSkillSlashCommand(value, ctx.repoRoot)
        const generator = query(
          rewrittenValue,
          ctx,
          props.shutdownSignal
            ? AbortSignal.any([controller.signal, props.shutdownSignal])
            : controller.signal,
        )
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
    props.onQuery?.(completion)
  }
  // Leave one terminal row free: Ink clears when leaving an exactly full frame too.
  const height = Math.max(0, rows - 1)
  const inputSpacer = display.transcript.length > 0 ? 1 : 0
  const controlHeight = pendingConfirm
    ? Math.max(0, height - statusHeight - 1 - inputSpacer)
    : bannerCommitted
      ? 3
      : inputHeight
  const spinnerHeight = isGenerating && !pendingConfirm ? 1 : 0
  const chromeHeight = controlHeight + statusHeight + 1 + spinnerHeight + inputSpacer
  const bannerRows = bannerCommitted
    ? 0
    : Math.min(
        Math.max(0, height - chromeHeight),
        layout === 'above'
          ? COMPACT_SIZE.lines + lines.length
          : layout === 'beside'
            ? Math.max(COMPACT_SIZE.lines, lines.length)
            : lines.length,
      )
  const contentHeight = Math.max(0, height - chromeHeight - bannerRows)
  const runningRows = Math.min(
    display.running.length,
    Math.max(0, contentHeight - (display.pending ? 5 : 0)),
  )
  const headerRows = display.pending && display.header ? 1 : 0
  const dynamicChromeHeight = chromeHeight + bannerRows + runningRows + headerRows
  const tailLines = Math.max(3, rows - dynamicChromeHeight - 2)
  const preview = wrapAssistant(
    renderMarkdown(display.pending).replace(/\n+$/, ''),
    contentMetrics.width,
  ).split('\n')
  const hidden = Math.max(0, preview.length - tailLines)
  // Ink relayouts on resize before React receives the resize event. A percentage width
  // follows that live layout immediately; the spare column avoids right-edge autowrap.
  return (
    <Box ref={parentRef} flexDirection="column" width="100%" paddingRight={1} overflow="hidden">
      <Static
        items={parentMetrics.hasMeasured ? display.transcript : []}
        style={{ width: '100%', paddingRight: 1 }}
      >
        {(item, index) => <DisplayEntry key={index} item={item} width={transcriptWidth} />}
      </Static>
      <Box flexDirection="column" maxHeight={height} overflow="hidden">
        {!bannerCommitted ? (
          <Box
            flexDirection="column"
            maxHeight={Math.max(0, height - chromeHeight)}
            overflow="hidden"
            flexShrink={0}
          >
            <StartupBanner
              snapshot={banner}
              frames={frames}
              animate={Boolean(
                stdout.isTTY &&
                  !resizing &&
                  layout !== 'text' &&
                  ctx.config?.ui.animation !== 'off' &&
                  process.env.OCTONOESIS_NO_ANIMATION !== '1',
              )}
            />
          </Box>
        ) : null}
        {!pendingConfirm ? (
          <Box flexDirection="row" maxHeight={contentHeight} overflow="hidden" flexShrink={0}>
            <Box ref={contentRef} flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              {display.pending && contentMetrics.hasMeasured ? (
                <Box flexDirection="column" flexShrink={0}>
                  {display.header ? <Text> </Text> : null}
                  {hidden ? <Text dimColor>… {hidden} lines above</Text> : null}
                  <Text wrap="truncate-end">{preview.slice(-tailLines).join('\n')}</Text>
                </Box>
              ) : null}
              <Box flexDirection="column" maxHeight={runningRows} overflow="hidden" flexShrink={0}>
                {display.running.map((tool) => (
                  <Box key={tool.id} height={1} flexShrink={0} overflow="hidden">
                    <ToolCard
                      width={contentMetrics.width}
                      tool={tool.name}
                      args={tool.args}
                      status="running"
                    />
                  </Box>
                ))}
              </Box>
            </Box>
            <TodoPanel maxRows={Math.max(0, height - chromeHeight)} />
          </Box>
        ) : null}
        {spinnerHeight ? (
          <Box height={1} flexShrink={0}>
            <Spinner startedAt={generationStarted.current} />
          </Box>
        ) : null}
        {inputSpacer ? (
          <Box height={1} flexShrink={0}>
            <Text> </Text>
          </Box>
        ) : null}
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
              onHeightChange={setInputHeight}
              history={inputHistory}
              onSubmit={handleSubmit}
              placeholder={placeholder}
              isDisabled={isGenerating}
            />
          )}
        </Box>
        <Box ref={statusRef} flexDirection="column" flexShrink={0}>
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
