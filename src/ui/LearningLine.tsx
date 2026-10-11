import { Box, Text } from 'ink'
import React from 'react'

/** Keep confidence values fixed while a long rule id shrinks to the parent width. */
export function LearningLine({
  prefix,
  text,
  suffix,
  width,
}: {
  prefix: string
  text: string
  suffix: string
  width?: number
}) {
  return (
    <Box width={width ?? '100%'} minWidth={0} height={1} overflow="hidden">
      <Box flexShrink={0}>
        <Text dimColor color="magenta">
          {prefix}
        </Text>
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <Text dimColor color="magenta" wrap="truncate-end">
          {text.replace(/\s+/g, ' ')}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor color="magenta">
          {suffix}
        </Text>
      </Box>
    </Box>
  )
}
