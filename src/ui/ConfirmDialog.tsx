import { Box, Text, useInput } from 'ink'
import React from 'react'

export interface ConfirmDialogProps {
  toolName: string
  input: unknown
  onResolve: (decision: 'allow_once' | 'allow_always' | 'deny') => void
}

export function ConfirmDialog({ toolName, input, onResolve }: ConfirmDialogProps) {
  // Listen for keyboard inputs
  useInput((inputStr) => {
    const key = inputStr.toLowerCase()
    if (key === 'y') {
      onResolve('allow_once')
    } else if (key === 'n') {
      onResolve('deny')
    } else if (key === 'a') {
      onResolve('allow_always')
    }
  })

  // Format parameters cleanly
  const paramsStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1} marginY={1}>
      <Box marginBottom={1}>
        <Text bold color="yellow">
          ⚠️ [Permission Required]
        </Text>
        <Text> Tool </Text>
        <Text bold color="cyan">
          {toolName}
        </Text>
        <Text> wants to execute.</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
        <Text bold color="gray">
          Parameters:
        </Text>
        <Text color="white">{paramsStr}</Text>
      </Box>

      <Box flexDirection="row">
        <Text>Press </Text>
        <Text bold color="green">
          [y]
        </Text>
        <Text> Yes once / </Text>
        <Text bold color="red">
          [n]
        </Text>
        <Text> No / </Text>
        <Text bold color="blue">
          [a]
        </Text>
        <Text> Always allow for this input</Text>
      </Box>
    </Box>
  )
}
