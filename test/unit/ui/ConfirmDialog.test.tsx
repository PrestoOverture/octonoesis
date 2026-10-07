import { describe, expect, mock, test } from 'bun:test'
import { render } from 'ink-testing-library'
import React from 'react'
import { ConfirmDialog } from '../../../src/ui/ConfirmDialog'

// ConfirmDialog renders its body only after useBoxMetrics measures the box, which can
// take longer than a fixed delay on slow CI runners; wait for the measured frame.
async function measuredFrame(lastFrame: () => string | undefined): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const frame = lastFrame() ?? ''
    if (frame.includes('[Permission Required]')) return frame
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return lastFrame() ?? ''
}
describe('ConfirmDialog TUI Component', async () => {
  test('renders tool name and formatted parameters correctly', async () => {
    const onResolve = mock(() => {})
    const { lastFrame } = render(
      <ConfirmDialog toolName="Bash" input={{ command: 'bun test' }} onResolve={onResolve} />,
    )

    const frame = await measuredFrame(lastFrame)
    expect(frame).toContain('[Permission Required]')
    expect(frame).toContain('Bash')
    expect(frame).toContain('bun test')
    expect(frame).toContain('[y]')
    expect(frame).toContain('Yes once')
  })

  test('calls onResolve with allow_once when y is pressed', async () => {
    const calls: string[] = []
    const onResolve = (decision: string) => {
      calls.push(decision)
    }

    const { stdin } = render(
      <ConfirmDialog toolName="Bash" input={{ command: 'bun test' }} onResolve={onResolve} />,
    )

    // Simulate pressing 'y'
    stdin.write('y')
    expect(calls.length).toBe(1)
    expect(calls[0]).toBe('allow_once')
  })

  test('calls onResolve with deny when n is pressed', async () => {
    const calls: string[] = []
    const onResolve = (decision: string) => {
      calls.push(decision)
    }

    const { stdin } = render(
      <ConfirmDialog toolName="Bash" input={{ command: 'bun test' }} onResolve={onResolve} />,
    )

    // Simulate pressing 'n'
    stdin.write('n')
    expect(calls.length).toBe(1)
    expect(calls[0]).toBe('deny')
  })

  test('calls onResolve with allow_always when a is pressed', async () => {
    const calls: string[] = []
    const onResolve = (decision: string) => {
      calls.push(decision)
    }

    const { stdin } = render(
      <ConfirmDialog toolName="Bash" input={{ command: 'bun test' }} onResolve={onResolve} />,
    )

    // Simulate pressing 'a'
    stdin.write('a')
    expect(calls.length).toBe(1)
    expect(calls[0]).toBe('allow_always')
  })

  test('renders diff preview when tool is Edit', async () => {
    const onResolve = mock(() => {})
    const editInput = {
      path: 'src/main.ts',
      old_string: 'const x = 1;',
      new_string: 'const x = 2;',
    }
    const { lastFrame } = render(
      <ConfirmDialog toolName="Edit" input={editInput} onResolve={onResolve} />,
    )

    const frame = await measuredFrame(lastFrame)
    expect(frame).toContain('File:')
    expect(frame).toContain('src/main.ts')
    expect(frame).toContain('@@')
    expect(frame).toContain('-const x = 1;')
    expect(frame).toContain('+const x = 2;')
  })

  test('does not render diff preview when tool is Write', async () => {
    const onResolve = mock(() => {})
    const writeInput = {
      path: 'src/main.ts',
      content: 'const x = 1;',
    }
    const { lastFrame } = render(
      <ConfirmDialog toolName="Write" input={writeInput} onResolve={onResolve} />,
    )

    const frame = await measuredFrame(lastFrame)
    expect(frame).toContain('src/main.ts')
    expect(frame).toContain('const x = 1;')
    expect(frame).not.toContain('@@')
  })
})
