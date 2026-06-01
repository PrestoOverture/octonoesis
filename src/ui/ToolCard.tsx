import { Box, Text } from 'ink'
import React from 'react'

export interface ToolCardProps {
  tool: string
  args: string
  status: 'running' | 'done' | 'error'
}

export const ToolCard = React.memo(({ tool, args, status }: ToolCardProps) => {
  let icon = '⏳'
  let color = 'yellow'
  let statusText = 'running'

  if (status === 'done') {
    icon = '✅'
    color = 'green'
    statusText = 'done'
  } else if (status === 'error') {
    icon = '❌'
    color = 'red'
    statusText = 'error'
  }

  // Truncate arguments to keep the visual card strictly to one single line
  const maxArgsLength = 50
  const truncatedArgs = args.length > maxArgsLength ? `${args.slice(0, maxArgsLength)}...` : args

  return (
    <Box marginY={0} paddingX={1} flexDirection="row">
      <Text color={color}>{icon} </Text>
      <Text bold color="white">
        {tool}
      </Text>
      <Text color="gray"> {truncatedArgs}</Text>
      <Text color={color} dimColor>
        {' '}
        ({statusText})
      </Text>
    </Box>
  )
})

ToolCard.displayName = 'ToolCard'
