import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'
import React, { useState, useEffect } from 'react'
import { registerPromptHandler, unregisterPromptHandler } from '../permissions/confirm'
import { type CanonicalMessage, type ToolContext, getRepoRoot, query } from '../query'
import { ConfirmDialog } from './ConfirmDialog'
import { StatusBar } from './StatusBar'
import { ToolCard } from './ToolCard'
export type { CanonicalMessage } from '../query'

export interface AppProps {
  messages?: CanonicalMessage[]
  streamingText?: string
  streamingToolUses?: { name: string; status?: 'running' | 'done' | 'error'; input?: unknown }[]
  placeholder?: string
}

export function MessageList({ messages = [] }: { messages?: CanonicalMessage[] }) {
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

export function StreamingResponse({
  text = '',
  toolUses = [],
}: {
  text?: string
  toolUses?: { name: string; status: 'running' | 'done' | 'error'; input?: unknown }[]
}) {
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

export function Input({
  value,
  onChange,
  onSubmit,
  placeholder = 'Type a message...',
  isDisabled = false,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  placeholder?: string
  isDisabled?: boolean
}) {
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

export function App({
  messages: initialMessages = [],
  streamingText: initialStreamingText = '',
  streamingToolUses: initialStreamingToolUses = [],
  placeholder = 'Type a message...',
}: AppProps) {
  const [ctx] = useState<ToolContext>(() => ({
    repoRoot: getRepoRoot(),
    messages: initialMessages,
  }))

  const [messages, setMessages] = useState<CanonicalMessage[]>(initialMessages)
  const [inputValue, setInputValue] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)

  // Permission dialog state
  interface PendingConfirm {
    toolName: string
    input: unknown
    resolve: (decision: 'allow_once' | 'allow_always' | 'deny') => void
  }
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null)

  // Register prompt handler at mount, unregister at unmount
  useEffect(() => {
    registerPromptHandler((toolName, input) => {
      return new Promise<'allow_once' | 'allow_always' | 'deny'>((resolve) => {
        setPendingConfirm({
          toolName,
          input,
          resolve: (decision) => {
            setPendingConfirm(null)
            resolve(decision)
          },
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

  // Cumulative token usage tracking
  const [usage, setUsage] = useState({ input_tokens: 0, output_tokens: 0 })

  const handleSubmit = (value: string) => {
    if (!value.trim() || isGenerating) return

    setIsGenerating(true)
    setInputValue('')

    // Immediately push User bubble to maintain high visual responsiveness
    const newMsg: CanonicalMessage = {
      role: 'user',
      content: [{ type: 'text', text: value }],
    }
    setMessages((prev) => [...prev, newMsg])

    // Execute query loop asynchronously in the background
    ;(async () => {
      try {
        const generator = query(value, ctx)
        for await (const event of generator) {
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
          } else if (event.type === 'message_end') {
            setUsage((prev) => ({
              input_tokens: prev.input_tokens + event.usage.input_tokens,
              output_tokens: prev.output_tokens + event.usage.output_tokens,
            }))
          }
        }

        // Commit full engine history to history layout state upon loop return
        if (ctx.messages) {
          setMessages([...ctx.messages])
        }
      } catch (err) {
        // Yield error states cleanly to console logging
      } finally {
        setStreamingText('')
        setStreamingToolUses([])
        setIsGenerating(false)
      }
    })()
  }

  return (
    <Box flexDirection="column" padding={1}>
      <MessageList messages={messages} />
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
      <StatusBar
        modelName="claude-haiku-4-5-20251001"
        inputTokens={usage.input_tokens}
        outputTokens={usage.output_tokens}
      />
    </Box>
  )
}
