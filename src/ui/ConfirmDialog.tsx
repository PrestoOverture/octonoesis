import { Box, type DOMElement, Text, useBoxMetrics, useInput, useWindowSize } from 'ink'
import React, { useRef } from 'react'
import { DiffPreview } from './DiffPreview'
import { wrapPreviewLines, wrapProseLines } from './previewLines'

/**
 * Props for the ConfirmDialog interactive tool authorization dialog.
 */
export interface ConfirmDialogProps {
  maxHeight?: number
  toolName: string
  input: unknown
  onResolve: (decision: 'allow_once' | 'allow_always' | 'deny') => void
}

/**
 * Renders an interactive confirmation dialog prompting the user to approve a tool execution.
 * @param props The props containing the tool name, tool input parameters, and resolution callback.
 * @returns A JSX.Element rendering the warning dialog and keystroke instructions.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const { toolName, input, onResolve, maxHeight } = props
  // Listen for keyboard inputs
  useInput((inputStr) => {
    const key = inputStr.toLowerCase()
    if (key === 'y') {
      onResolve('allow_once')
    } else if (key === 'n') {
      onResolve('deny')
    } else if (key === 'a') {
      onResolve('allow_always')
    }
  })

  const isEdit = toolName === 'Edit'
  const editInput = input as { path: string; old_string: string; new_string: string }

  // Format parameters cleanly for non-Edit tools
  const paramsStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2)

  const { rows } = useWindowSize()
  const ref = useRef<DOMElement>(null)
  const metrics = useBoxMetrics(ref)
  const width = Math.max(1, metrics.width - 2)
  const heading = wrapProseLines(
    `! [Permission Required] Tool ${toolName} wants to execute.`,
    width,
  )
  const footer = wrapProseLines(
    'Press [y] Yes once / [n] No / [a] Always allow for this input',
    width,
  )
  const label = wrapProseLines(isEdit ? `File: ${editInput.path}` : 'Parameters:', width)
  // Borders, heading, payload label and answer keys are accounted for before the body.
  const bodyRows = Math.max(
    1,
    (maxHeight ?? rows - 7) - 2 - heading.length - footer.length - label.length,
  )
  const parameters = wrapPreviewLines(paramsStr ?? '', width)
  const visible = parameters.slice(0, parameters.length > bodyRows ? bodyRows - 1 : bodyRows)
  const hidden = parameters.length - visible.length
  return (
    <Box
      ref={ref}
      width="100%"
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      flexShrink={0}
    >
      {metrics.hasMeasured ? (
        <>
          <Text bold color="yellow">
            {heading.join('\n')}
          </Text>
          <Text bold color="gray">
            {label.join('\n')}
          </Text>
          {isEdit ? (
            <DiffPreview
              oldText={editInput.old_string}
              newText={editInput.new_string}
              filePath={editInput.path}
              maxLines={bodyRows}
              columns={width}
            />
          ) : (
            <Box flexDirection="column" flexShrink={0}>
              <Text color="white">{visible.join('\n')}</Text>
              {hidden ? <Text color="yellow">… {hidden} more lines not shown</Text> : null}
            </Box>
          )}
          <Text>{footer.join('\n')}</Text>
        </>
      ) : null}
    </Box>
  )
}
