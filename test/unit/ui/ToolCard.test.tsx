import { describe, expect, it } from 'bun:test'
import { Box } from 'ink'
import { render } from 'ink-testing-library'
import React from 'react'
import { DisplayEntry } from '../../../src/ui/App'
import { ToolCard } from '../../../src/ui/ToolCard'
import { seedTranscript, transcriptReducer } from '../../../src/ui/transcript'

describe('ToolCard Component', () => {
  it('renders correctly for status "running"', () => {
    const { lastFrame } = render(<ToolCard tool="Bash" args="bun test" status="running" />)
    const frame = lastFrame()
    expect(frame).toBeDefined()
    if (frame) {
      expect(frame).toContain('…')
      expect(frame).toContain('Bash')
      expect(frame).toContain('bun test')
      expect(frame).toContain('… Bash bun test')
    }
  })

  it('renders correctly for status "done"', () => {
    const { lastFrame } = render(<ToolCard tool="Read" args="package.json" status="done" />)
    const frame = lastFrame()
    expect(frame).toBeDefined()
    if (frame) {
      expect(frame).toContain('✓')
      expect(frame).toContain('Read')
      expect(frame).toContain('package.json')
      expect(frame).toContain('✓ Read package.json')
    }
  })

  it('renders correctly for status "error"', () => {
    const { lastFrame } = render(<ToolCard tool="Glob" args="invalid/**" status="error" />)
    const frame = lastFrame()
    expect(frame).toBeDefined()
    if (frame) {
      expect(frame).toContain('✗')
      expect(frame).toContain('Glob')
      expect(frame).toContain('invalid/**')
      expect(frame).toContain('✗ Glob invalid/**')
    }
  })
})

it('renders summaries from live completion, cancellation and resumed errors', () => {
  let state = seedTranscript()
  state = transcriptReducer(state, {
    type: 'tool_use',
    id: 'r',
    name: 'Read',
    input: { path: 'src/x.ts' },
  })
  state = transcriptReducer(state, {
    type: 'tool_done',
    id: 'r',
    name: 'Read',
    status: 'done',
    summary: '3 lines',
  })
  state = transcriptReducer(state, {
    type: 'tool_use',
    id: 'b',
    name: 'Bash',
    input: { command: '…' },
  })
  state = transcriptReducer(state, {
    type: 'tool_done',
    id: 'b',
    name: 'Bash',
    status: 'error',
    summary: 'exit 1',
  })
  state = transcriptReducer(state, {
    type: 'tool_use',
    id: 'c',
    name: 'Read',
    input: { path: 'cancel.ts' },
  })
  state = transcriptReducer(state, { type: 'end' })
  const live = render(
    <Box flexDirection="column">
      {state.transcript.map((item, index) => (
        <DisplayEntry key={String(index)} item={item} />
      ))}
    </Box>,
  )
  expect(live.lastFrame()).toContain('✓ Read src/x.ts · 3 lines')
  expect(live.lastFrame()).toContain('✗ Bash … · exit 1')
  expect(live.lastFrame()).toContain('✗ Read cancel.ts · cancelled')
  live.unmount()
  const resumed = seedTranscript([
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'e', name: 'Edit', input: { path: 'x.ts' } },
        { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'exit 1' } },
      ],
    },
    {
      role: 'tool',
      tool_use_id: 'e',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'e',
          content: '{"error":"must_read_first: read first"}',
          is_error: true,
        },
        { type: 'text', text: '{"error":"must_read_first: read first"}' },
      ],
    },
    { role: 'tool', tool_use_id: 'b', content: '{"code":1,"stdout":"","stderr":""}' },
  ])
  const history = render(
    <Box flexDirection="column">
      {resumed.transcript.map((item, index) => (
        <DisplayEntry key={String(index)} item={item} />
      ))}
    </Box>,
  )
  expect(history.lastFrame()).toContain('✗ Edit x.ts · must_read_first')
  expect(history.lastFrame()).toContain('✗ Bash exit 1 · exit 1')
  history.unmount()
})

it('keeps a multiline error summary on one rendered line', () => {
  const view = render(
    <ToolCard tool="Unknown" args={'arg\nsecond'} status="error" summary={'first\nsecond'} />,
  )
  expect(view.lastFrame()).toBe('✗ Unknown arg · first second')
  view.unmount()
})
