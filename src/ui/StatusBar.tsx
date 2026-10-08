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

const formatTokens = (count: number): string =>
  count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)

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
  }: StatusBarProps) => (
    <Box width="100%" minWidth={0}>
      <Text wrap="truncate-end" color="gray" dimColor>
        {`${modelName} · ${priced === false ? 'cost n/a' : `$${(costUsd ?? 0).toFixed(4)}`} · ctx ${Math.round((contextUtilization ?? 0) * 100)}% · ${formatTokens(inputTokens)} in / ${formatTokens(outputTokens)} out`}
      </Text>
    </Box>
  ),
)
StatusBar.displayName = 'StatusBar'
