import crypto from 'node:crypto'
import { Box, Text, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'
import React, { useState, useEffect, useRef } from 'react'
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
import { getRepoRoot } from '../utils/path'
import { CompactNotice } from './CompactNotice'
import { ConfirmDialog } from './ConfirmDialog'
import { StatusBar } from './StatusBar'
import { TaskChip } from './TaskChip'
import { TodoPanel } from './TodoPanel'
import { ToolCard } from './ToolCard'
export type { CanonicalMessage } from '../query'

export interface AppProps {
  messages?: CanonicalMessage[]
  streamingText?: string
  streamingToolUses?: { name: string; status?: 'running' | 'done' | 'error'; input?: unknown }[]
  placeholder?: string
  sandbox?: ResolvedSandboxConfig
  ctx?: ToolContext
  onSessionState?: (sessionState: SessionState, priced: boolean) => void
}

/**
 * MessageList renders the chronological history of user messages and agent turns,
 * rendering tool usages as compact <ToolCard> components.
 * @param props The props containing the messages list.
 * @returns The rendered Box containing message logs.
 */
export function MessageList(props: { messages?: CanonicalMessage[] }) {
  const { messages = [] } = props
  return (
    <Box flexDirection="column">
      {messages.map((msg, index) => {
        if (msg.role === 'user') {
          const text =
            typeof msg.content === 'string'
              ? msg.content
              : msg.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: indices are stable in terminal chat history
            <Box key={index} flexDirection="column" marginY={0}>
              <Text bold color="cyan">
                User › <Text color="white">{text}</Text>
              </Text>
            </Box>
          )
        }
        if (msg.role === 'assistant') {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: indices are stable in terminal chat history
            <Box key={index} flexDirection="column" marginY={0}>
              <Text bold color="green">
                Agent ›
              </Text>
              {msg.content.map((block, bIdx) => {
                if (block.type === 'text') {
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: indices are stable in terminal chat history
                    <Text key={bIdx} color="white">
                      {block.text}
                    </Text>
                  )
                }
                if (block.type === 'tool_use') {
                  // Find subsequent tool result to determine completion status
                  const resultMsg = messages[index + 1]
                  const isError =
                    resultMsg &&
                    resultMsg.role === 'tool' &&
                    typeof resultMsg.content === 'string' &&
                    resultMsg.content.includes('"error":')

                  const status = isError ? 'error' : 'done'
                  const argsStr = block.input ? JSON.stringify(block.input) : ''
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: indices are stable in terminal chat history
                    <ToolCard key={bIdx} tool={block.name} args={argsStr} status={status} />
                  )
                }
                return null
              })}
            </Box>
          )
        }
        // Hide raw tool outputs to keep TUI scrollback clean
        return null
      })}
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
          <Text color="white">{text}</Text>
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
 * Input renders the interactive prompt line where user enters message instructions.
 * @param props The props containing value, handlers, placeholder and disabled state.
 * @returns The rendered Box containing the input field layout.
 */
export function Input(props: {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  placeholder?: string
  isDisabled?: boolean
}) {
  const { value, onChange, onSubmit, placeholder = 'Type a message...', isDisabled = false } = props
  return (
    <Box flexDirection="column" marginTop={0}>
      <Box flexDirection="row">
        <Text color="cyan">🤖 › </Text>
        {isDisabled ? (
          <Text color="gray">{placeholder}</Text>
        ) : (
          <TextInput
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            placeholder={placeholder}
          />
        )}
      </Box>
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
  } = props
  const [ctx] = useState<ToolContext>(() => {
    if (providedCtx) {
      providedCtx.messages ??= initialMessages
      return providedCtx
    }
    const sessionId = crypto.randomUUID()
    const model = getResolvedModel()
    return {
      repoRoot: getRepoRoot(),
      messages: initialMessages,
      sessionId,
      sessionState: createSessionState(sessionId, model),
      sandbox,
    }
  })

  const [messages, setMessages] = useState<CanonicalMessage[]>(initialMessages)
  const [inputValue, setInputValue] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [compactNotices, setCompactNotices] = useState<
    { id: number; preTokens: number; postTokens: number; durationMs: number }[]
  >([])
  const compactNoticeIdRef = useRef(0)

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

  // Streaming states (hooks default props cleanly for tests)
  const [streamingText, setStreamingText] = useState(initialStreamingText)
  const [streamingToolUses, setStreamingToolUses] = useState<
    { name: string; status: 'running' | 'done' | 'error'; input?: unknown }[]
  >(() =>
    initialStreamingToolUses.map((t) => ({
      name: t.name,
      status: t.status || 'running',
      input: t.input,
    })),
  )

  const modelName = getResolvedModel()
  const initialPricing = estimateCost({ input_tokens: 0, output_tokens: 0 }, modelName)
  const [sessionView, setSessionView] = useState<{
    sessionState: SessionState
    priced: boolean
  } | null>(null)

  const handleSubmit = (value: string) => {
    if (!value.trim() || isGenerating) return

    if (value.trim() === '/stats') {
      const userMsg: CanonicalMessage = {
        role: 'user',
        content: [{ type: 'text', text: value }],
      }
      setInputValue('')
      setMessages((prev) => [...prev, userMsg])
      ;(async () => {
        try {
          const { readCalibrationRecords, aggregateCalibrationStats } = await import(
            '../memory/calibration/stats.ts'
          )
          const { formatStatsTable } = await import('../memory/calibration/format.ts')
          const records = await readCalibrationRecords()
          const statsList = aggregateCalibrationStats(records)
          const table = formatStatsTable(statsList)

          const assistantMsg: CanonicalMessage = {
            role: 'assistant',
            content: [{ type: 'text', text: table }],
          }
          setMessages((prev) => [...prev, assistantMsg])
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          const assistantMsg: CanonicalMessage = {
            role: 'assistant',
            content: [{ type: 'text', text: `Failed to load stats: ${errMsg}` }],
          }
          setMessages((prev) => [...prev, assistantMsg])
        }
      })()
      return
    }

    setIsGenerating(true)
    setInputValue('')

    // Immediately push User bubble to maintain high visual responsiveness
    const newMsg: CanonicalMessage = {
      role: 'user',
      content: [{ type: 'text', text: value }],
    }
    setMessages((prev) => [...prev, newMsg])

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
          if (event.type === 'text_delta') {
            setStreamingText((prev) => prev + event.text)
          } else if (event.type === 'tool_use') {
            setStreamingToolUses((prev) => [
              ...prev,
              { name: event.name, status: 'running', input: event.input },
            ])
          } else if (event.type === 'tool_done') {
            // Update ToolCard statuses to (done) or (error)
            setStreamingToolUses((prev) =>
              prev.map((t) =>
                t.name === event.name && t.status === 'running'
                  ? { ...t, status: event.status }
                  : t,
              ),
            )
          } else if (event.type === 'compact') {
            compactNoticeIdRef.current++
            setCompactNotices((prev) => [
              ...prev,
              {
                id: compactNoticeIdRef.current,
                preTokens: event.preTokens,
                postTokens: event.postTokens,
                durationMs: event.durationMs,
              },
            ])
          } else if (event.type === 'session_state') {
            const sessionState = {
              ...event.sessionState,
              usage: { ...event.sessionState.usage },
            }
            setSessionView({ sessionState, priced: event.priced })
            onSessionState?.(sessionState, event.priced)
          }
        }

        // Commit full engine history to history layout state upon loop return
        const history = [...(ctx.messages ?? [])]
        const failure = formatQueryFailure(queryResult)
        if (failure) {
          history.push({ role: 'assistant', content: [{ type: 'text', text: failure }] })
        }
        setMessages(history)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        setMessages([
          ...(ctx.messages ?? []),
          {
            role: 'assistant',
            content: [{ type: 'text', text: `Query failed: ${detail}` }],
          },
        ])
      } finally {
        setStreamingText('')
        setStreamingToolUses([])
        setIsGenerating(false)
        abortControllerRef.current = null
      }
    })()
  }
  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" flexGrow={1}>
          <MessageList messages={messages} />
          {compactNotices.map((notice) => (
            <CompactNotice
              key={notice.id}
              preTokens={notice.preTokens}
              postTokens={notice.postTokens}
              durationMs={notice.durationMs}
            />
          ))}
          <StreamingResponse text={streamingText} toolUses={streamingToolUses} />
          {pendingConfirm ? (
            <ConfirmDialog
              toolName={pendingConfirm.toolName}
              input={pendingConfirm.input}
              onResolve={pendingConfirm.resolve}
            />
          ) : (
            <Input
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleSubmit}
              placeholder={placeholder}
              isDisabled={isGenerating}
            />
          )}
        </Box>
        <TodoPanel />
      </Box>
      <StatusBar
        modelName={sessionView?.sessionState.model ?? modelName}
        inputTokens={sessionView?.sessionState.usage.input_tokens ?? 0}
        outputTokens={sessionView?.sessionState.usage.output_tokens ?? 0}
        costUsd={sessionView?.sessionState.costUsd ?? 0}
        priced={sessionView?.priced ?? initialPricing.priced}
        contextUtilization={sessionView?.sessionState.contextUtilization ?? 0}
      />
      <TaskChip ctx={ctx} />
    </Box>
  )
}
