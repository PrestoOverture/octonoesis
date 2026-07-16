import { describe, expect, it } from 'bun:test'
import { render } from 'ink-testing-library'
import React from 'react'
import { PromptInput } from '../../../src/ui/PromptInput.tsx'

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe('PromptInput', () => {
  it('recalls older history and restores the stashed draft on Down', async () => {
    const view = render(<PromptInput history={['yesterday prompt']} onSubmit={() => {}} />)
    view.stdin.write('work in progress')
    await settle()
    view.stdin.write('\x1b[A')
    await settle()
    expect(view.lastFrame()).toContain('yesterday prompt')
    view.stdin.write('\x1b[B')
    await settle()
    expect(view.lastFrame()).toContain('work in progress')
    expect(view.lastFrame()).toContain('↑ history')
    view.unmount()
  })

  it('keeps a multiline draft intact when Up moves within the buffer', async () => {
    const view = render(<PromptInput history={['must not replace']} onSubmit={() => {}} />)
    view.stdin.write('line one\nline two')
    await settle()
    view.stdin.write('\x1b[A')
    await settle()

    const frame = view.lastFrame() ?? ''
    expect(frame).toContain('line one')
    expect(frame).toContain('line two')
    expect(frame).not.toContain('must not replace')
    view.unmount()
  })

  it('turns backslash Enter into a newline and submits the whole buffer once', async () => {
    const submitted: string[] = []
    const view = render(<PromptInput history={[]} onSubmit={(value) => submitted.push(value)} />)
    view.stdin.write('first\\')
    await settle()
    view.stdin.write('\r')
    await settle()
    expect(submitted).toEqual([])
    view.stdin.write('second')
    await settle()
    view.stdin.write('\r')
    await settle()

    expect(submitted).toEqual(['first\nsecond'])
    view.unmount()
  })
})
