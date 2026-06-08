import { describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import React from 'react'
import { DiffPreview } from '../../../src/ui/DiffPreview'

describe('DiffPreview Component', () => {
  test('renders unified diff correctly with context lines', () => {
    const oldText = 'line one\nline two\nline three'
    const newText = 'line one\nline modified\nline three'
    const { lastFrame } = render(
      <DiffPreview oldText={oldText} newText={newText} filePath="test.txt" />,
    )

    const frame = lastFrame()
    console.log(frame)
    // Check that we render hunk headers and line content modifications
    expect(frame).toContain('@@')
    expect(frame).toContain('-line two')
    expect(frame).toContain('+line modified')
  })

  test('truncates long diff outputs', () => {
    const oldText = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const newText = Array.from({ length: 40 }, (_, i) => `modified ${i}`).join('\n')

    const { lastFrame } = render(
      <DiffPreview oldText={oldText} newText={newText} filePath="test.txt" />,
    )

    const frame = lastFrame()
    console.log(frame)
    // It should have truncated the output and displayed the truncation indicator
    expect(frame).toContain('lines truncated')
  })
})
