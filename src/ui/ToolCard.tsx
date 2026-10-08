import { Box, type DOMElement, Text, useBoxMetrics } from 'ink'
import React, { useRef } from 'react'

declare const Bun: { stringWidth(text: string): number }

/**
 * Props for the ToolCard component displaying execution status of a tool.
 */
export interface ToolCardProps {
  width?: number
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
function ToolLine({ tool, args, status, summary, width }: ToolCardProps) {
  const argument = args ? ` ${args.split(/\r?\n/)[0]}` : ''
  const suffix = status !== 'running' && summary ? ` · ${summary.replace(/\r?\n/g, ' ')}` : ''
  const label = (
    <>
      <Text color={status === 'done' ? 'green' : status === 'error' ? 'red' : 'yellow'}>
        {status === 'done' ? '✓' : status === 'error' ? '✗' : '…'}{' '}
      </Text>
      <Text bold>{tool}</Text>
    </>
  )
  const fixedWidth = Bun.stringWidth(`✓ ${tool}${suffix}`)
  return (
    <Box width="100%" minWidth={0} flexShrink={1}>
      {width === undefined || fixedWidth > width ? (
        <Text wrap="truncate-end">
          {label}
          {argument}
          <Text dimColor>{suffix}</Text>
        </Text>
      ) : (
        <>
          <Box flexShrink={0}>
            <Text>{label}</Text>
          </Box>
          {argument ? (
            <Box flexShrink={1} minWidth={0}>
              <Text wrap="truncate-end">{argument}</Text>
            </Box>
          ) : null}
          {suffix ? (
            <Box flexShrink={0}>
              <Text dimColor>{suffix}</Text>
            </Box>
          ) : null}
        </>
      )}
    </Box>
  )
}

function MeasuredToolCard(props: ToolCardProps) {
  const ref = useRef<DOMElement>(null)
  const metrics = useBoxMetrics(ref)
  return (
    <Box ref={ref} width="100%" minWidth={0}>
      <ToolLine {...props} width={metrics.hasMeasured ? metrics.width : undefined} />
    </Box>
  )
}

export const ToolCard = React.memo((props: ToolCardProps) =>
  props.width === undefined ? <MeasuredToolCard {...props} /> : <ToolLine {...props} />,
)
ToolCard.displayName = 'ToolCard'
