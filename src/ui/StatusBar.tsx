import { Box, Text } from 'ink'
import React from 'react'

export interface StatusBarProps {
  modelName: string
  inputTokens: number
  outputTokens: number
}

export const StatusBar = React.memo(({ modelName, inputTokens, outputTokens }: StatusBarProps) => {
  const totalTokens = inputTokens + outputTokens

  // Format token counts in an abbreviated format if they grow large
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
