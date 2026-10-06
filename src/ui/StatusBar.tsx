import { Box, Text } from 'ink'
import React from 'react'

/**
 * Props for the StatusBar component displaying model info, token metrics, and cost.
 */
export interface StatusBarProps {
  modelName: string
  inputTokens: number
  outputTokens: number
  costUsd?: number
  priced?: boolean
  contextUtilization?: number
}

/**
 * Renders a bottom status bar displaying the active LLM model and token usage.
 * @param props The props containing the model name, input token count, and output token count.
 * @returns A JSX.Element showing the status bar.
 */
export const StatusBar = React.memo(
  ({
    modelName,
    inputTokens,
    outputTokens,
    costUsd,
    priced,
    contextUtilization,
  }: StatusBarProps) => {
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
        width="100%"
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        flexDirection="column"
        marginTop={1}
      >
        <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between">
          <Box flexShrink={1} minWidth={0} flexBasis={33}>
            <Text wrap="truncate-end" color="cyan">
              Model:{' '}
              <Text bold color="white">
                {modelName}
              </Text>
            </Text>
          </Box>
          <Box flexShrink={1} minWidth={0}>
            <Text wrap="truncate-end">
              {priced !== undefined || costUsd !== undefined ? (
                <Text bold color="yellow">
                  {priced === false ? 'cost: n/a' : `cost: $${(costUsd ?? 0).toFixed(4)}`}
                </Text>
              ) : null}
              {contextUtilization !== undefined ? (
                <>
                  {priced !== undefined || costUsd !== undefined ? (
                    <Text color="gray"> | </Text>
                  ) : null}
                  <Text bold color="magenta">
                    ctx: {Math.round(contextUtilization * 100)}%
                  </Text>
                </>
              ) : null}
            </Text>
          </Box>
        </Box>
        <Text wrap="truncate-end" color="gray">
          Usage:{' '}
          <Text bold color="green">
            in: {formatTokens(inputTokens)}
          </Text>
          {' | '}
          <Text bold color="green">
            out: {formatTokens(outputTokens)}
          </Text>
          {' | '}
          <Text bold color="green">
            total: {formatTokens(totalTokens)}
          </Text>
        </Text>
      </Box>
    )
  },
)

StatusBar.displayName = 'StatusBar'
