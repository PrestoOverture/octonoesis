import { describe, expect, it } from 'bun:test'
import { render } from 'ink-testing-library'
import React from 'react'
import { CompactNotice } from '../../../src/ui/CompactNotice'
import { StatusBar } from '../../../src/ui/StatusBar'

describe('observability UI', () => {
  it('renders priced session cost and context utilization in the StatusBar', () => {
    const { lastFrame } = render(
      <StatusBar
        modelName="claude-haiku-4-5"
        inputTokens={1_500}
        outputTokens={500}
        costUsd={1.23456}
        priced={true}
        contextUtilization={0.424}
      />,
    )

    const frame = lastFrame() ?? ''
    expect(frame).toContain('cost: $1.2346')
    expect(frame).toContain('ctx: 42%')
  })

  it('renders n/a instead of a fake zero for an unpriced model', () => {
    const { lastFrame } = render(
      <StatusBar
        modelName="unknown-model"
        inputTokens={100}
        outputTokens={20}
        costUsd={0}
        priced={false}
        contextUtilization={0.01}
      />,
    )

    const frame = lastFrame() ?? ''
    expect(frame).toContain('cost: n/a')
    expect(frame).not.toContain('cost: $0.0000')
    expect(frame).toContain('ctx: 1%')
  })

  it('renders the polished compact notice with its established leading line', () => {
    const { lastFrame } = render(
      <CompactNotice preTokens={23_636} postTokens={6_238} durationMs={125} />,
    )

    const frame = lastFrame() ?? ''
    expect(frame).toContain('✻ Context compacted: 23,636 → 6,238 tokens')
    expect(frame).toContain('125 ms')
  })

  it('keeps every StatusBar field readable at 80 columns', () => {
    const { lastFrame } = render(
      <StatusBar
        modelName="claude-haiku-4-5-20251001"
        inputTokens={12_345}
        outputTokens={678}
        costUsd={0.0123}
        priced={true}
        contextUtilization={0.42}
      />,
    )

    const frame = lastFrame() ?? ''
    expect(frame).toContain('Model: claude-haiku-4-5-20251001')
    expect(frame).toContain('in: 12.3k')
    expect(frame).toContain('out: 678')
    expect(frame).toContain('total: 13.0k')
    expect(frame).toContain('cost: $0.0123')
    expect(frame).toContain('ctx: 42%')
  })
})
