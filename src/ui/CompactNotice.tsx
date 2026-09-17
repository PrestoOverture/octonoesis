import { Box, Text } from 'ink'
import React from 'react'

export interface CompactNoticeProps {
  preTokens: number
  postTokens: number
  durationMs: number
}

/**
 * Terminal UI component that displays a notification banner when context compaction occurs.
 *
 * @param props - Component properties containing token counts and compaction duration
 * @returns Rendered compact notice box element
 */
export const CompactNotice = React.memo(
  ({ preTokens, postTokens, durationMs }: CompactNoticeProps) => (
    <Box flexDirection="row">
      <Text color="yellow">
        ✻ Context compacted: {preTokens.toLocaleString('en-US')} →{' '}
        {postTokens.toLocaleString('en-US')} tokens
      </Text>
      <Text color="gray"> · {Math.round(durationMs).toLocaleString('en-US')} ms</Text>
    </Box>
  ),
)

CompactNotice.displayName = 'CompactNotice'
