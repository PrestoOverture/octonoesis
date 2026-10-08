import { Box, Text } from 'ink'
import React from 'react'

/**
 * Props for the ToolCard component displaying execution status of a tool.
 */
export interface ToolCardProps {
  tool: string
  args: string
  summary?: string
  status: 'running' | 'done' | 'error'
}

/**
 * Renders a visual one-line card showing the status of a tool execution.
 * @param props The props containing the tool name, primary argument, summary, and current execution status.
 * @returns A JSX.Element showing the tool card.
 */
export const ToolCard = React.memo(({ tool, args, status, summary }: ToolCardProps) => (
  <Box width="100%" minWidth={0} flexShrink={1}>
    <Text wrap="truncate-end">
      <Text color={status === 'done' ? 'green' : status === 'error' ? 'red' : 'yellow'}>
        {status === 'done' ? '✓' : status === 'error' ? '✗' : '…'}{' '}
      </Text>
      <Text bold>{tool}</Text>
      {args ? ` ${args.split(/\r?\n/)[0]}` : ''}
      {status !== 'running' && summary ? (
        <Text dimColor>{` · ${summary.replace(/\r?\n/g, ' ')}`}</Text>
      ) : null}
    </Text>
  </Box>
))
ToolCard.displayName = 'ToolCard'
