import { Box, Text } from 'ink'
import React from 'react'

export interface CompactNoticeProps {
  preTokens: number
  postTokens: number
  durationMs: number
}

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
