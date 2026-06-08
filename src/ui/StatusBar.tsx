import { Box, Text } from 'ink'
import React from 'react'

export interface StatusBarProps {
  modelName: string
  inputTokens: number
  outputTokens: number
}

/**
 * Renders a bottom status bar displaying the active LLM model and token usage.
 * @param props The props containing the model name, input token count, and output token count.
 * @returns A JSX.Element showing the status bar.
 */
export const StatusBar = React.memo(({ modelName, inputTokens, outputTokens }: StatusBarProps) => {
  const totalTokens = inputTokens + outputTokens

  /**
   * Formats a token count into a human-readable abbreviated string (e.g. 1.5k).
   * @param count The numeric token count.
   * @returns The formatted string representation of the token count.
   */
  const formatTokens = (count: number): string => {
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}k`
    }
    return String(count)
  }

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      flexDirection="row"
      justifyContent="space-between"
      marginTop={1}
    >
      <Box flexDirection="row">
        <Text color="cyan">Model: </Text>
        <Text bold color="white">
          {modelName}
        </Text>
      </Box>
      <Box flexDirection="row">
        <Text color="gray">Usage: </Text>
        <Text bold color="green">
          in: {formatTokens(inputTokens)}
        </Text>
        <Text color="gray"> | </Text>
        <Text bold color="green">
          out: {formatTokens(outputTokens)}
        </Text>
        <Text color="gray"> | </Text>
        <Text bold color="green">
          total: {formatTokens(totalTokens)}
        </Text>
      </Box>
    </Box>
  )
})

StatusBar.displayName = 'StatusBar'
