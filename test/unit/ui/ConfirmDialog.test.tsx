import { describe, expect, mock, test } from 'bun:test'
import { render } from 'ink-testing-library'
import React from 'react'
import { ConfirmDialog } from '../../../src/ui/ConfirmDialog'

describe('ConfirmDialog TUI Component', () => {
  test('renders tool name and formatted parameters correctly', () => {
    const onResolve = mock(() => {})
    const { lastFrame } = render(
      <ConfirmDialog toolName="Bash" input={{ command: 'bun test' }} onResolve={onResolve} />,
    )

    const frame = lastFrame()
    expect(frame).toContain('[Permission Required]')
    expect(frame).toContain('Bash')
    expect(frame).toContain('bun test')
    expect(frame).toContain('[y]')
    expect(frame).toContain('Yes once')
  })

  test('calls onResolve with allow_once when y is pressed', () => {
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

  test('calls onResolve with deny when n is pressed', () => {
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

  test('calls onResolve with allow_always when a is pressed', () => {
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
})
