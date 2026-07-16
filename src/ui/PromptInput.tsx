import { Box, Text, useInput } from 'ink'
import React, { useState } from 'react'
import {
  type InputHistoryCursor,
  createInputHistoryCursor,
  navigateInputHistory,
} from './inputHistory.ts'
import { type PromptBuffer, applyPromptInput, createPromptBuffer } from './promptBuffer.ts'

export interface PromptInputProps {
  history: string[]
  onSubmit: (value: string) => void
  placeholder?: string
  isDisabled?: boolean
  initialValue?: string
}

function BufferView(props: { buffer: PromptBuffer; placeholder: string }) {
  const { buffer, placeholder } = props
  if (buffer.text.length === 0) return <Text color="gray">{placeholder}</Text>
  const before = buffer.text.slice(0, buffer.cursor)
  const atCursor = buffer.text[buffer.cursor]
  const cursorGlyph = atCursor === undefined || atCursor === '\n' ? ' ' : atCursor
  const after =
    atCursor === undefined
      ? ''
      : atCursor === '\n'
        ? `\n${buffer.text.slice(buffer.cursor + 1)}`
        : buffer.text.slice(buffer.cursor + 1)
  return (
    <Text>
      {before}
      <Text inverse>{cursorGlyph}</Text>
      {after}
    </Text>
  )
}

export function PromptInput(props: PromptInputProps) {
  const {
    history,
    onSubmit,
    placeholder = 'Type a message...',
    isDisabled = false,
    initialValue = '',
  } = props
  const [buffer, setBuffer] = useState(() => createPromptBuffer(initialValue))
  const [historyCursor, setHistoryCursor] = useState<InputHistoryCursor>(() =>
    createInputHistoryCursor(),
  )

  useInput(
    (input, key) => {
      const action = applyPromptInput(buffer, input, key)
      if (action.type === 'edit') {
        if (action.buffer.text !== buffer.text) setHistoryCursor(createInputHistoryCursor())
        setBuffer(action.buffer)
        return
      }
      if (action.type === 'history') {
        const navigation = navigateInputHistory(
          history,
          historyCursor,
          action.direction,
          buffer.text,
        )
        setHistoryCursor(navigation.cursor)
        setBuffer(createPromptBuffer(navigation.value))
        return
      }
      if (action.type === 'submit' && action.value.trim()) {
        onSubmit(action.value)
        setBuffer(createPromptBuffer())
        setHistoryCursor(createInputHistoryCursor())
      }
    },
    { isActive: !isDisabled },
  )

  return (
    <Box flexDirection="column" marginTop={0}>
      <Box flexDirection="row">
        <Text color="cyan">🤖 › </Text>
        {isDisabled ? (
          <Text color="gray">{placeholder}</Text>
        ) : (
          <BufferView buffer={buffer} placeholder={placeholder} />
        )}
      </Box>
      <Text dimColor>{'\\⏎ or ⌥⏎ newline · ↑ history'}</Text>
    </Box>
  )
}
