import { describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { render } from 'ink-testing-library'
import React from 'react'
import { App, type CanonicalMessage, formatTaskNoticeLabel } from '../../../src/ui/App'

describe('App TUI component', () => {
  it('renders MessageList, StreamingResponse, and Input regions', () => {
    const messages: CanonicalMessage[] = [
      { role: 'user', content: 'hello agent' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello human' }] },
    ]

    const { lastFrame } = render(
      <App
        messages={messages}
        streamingText="thinking..."
        streamingToolUses={[{ name: 'Bash' }]}
      />,
    )

    const frame = lastFrame()
    expect(frame).toBeDefined()
    if (frame) {
      // 1. Verify MessageList renders conversation history (separated to prevent ANSI-color interference)
      expect(frame).toContain('User ›')
      expect(frame).toContain('hello agent')
      expect(frame).toContain('Agent ›')
      expect(frame).toContain('hello human')

      // 2. Verify StreamingResponse renders progressive stream & tool state
      expect(frame).toContain('thinking...')
      expect(frame).toContain('⏳')
      expect(frame).toContain('Bash')
      expect(frame).toContain('(running)')

      // 3. Verify Input container prompts user
      expect(frame).toContain('🤖 ›')
    }
  })

  it('intercepts /stats command and displays calibration stats inline', async () => {
    const testDir = path.join(__dirname, '../../../test-app-stats-memory')
    const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
    process.env.OCTONOESIS_MEMORY_DIR = testDir
    try {
      await fs.mkdir(testDir, { recursive: true })

      const mockRecord = {
        session_id: 'sess-test-app',
        ts: new Date().toISOString(),
        bucket_key: 'bun-test|TypeError',
        model_id: 'gpt-5-nano',
        attempt_count: 5,
        first_attempt_success: true,
        user_modifications: 0,
        user_reverts: 0,
        resolved: true,
      }
      await fs.writeFile(
        path.join(testDir, 'calibration.jsonl'),
        `${JSON.stringify(mockRecord)}\n`,
        'utf8',
      )

      const { stdin, lastFrame } = render(<App />)
      // Simulate typing "/stats"
      stdin.write('/stats')
      await new Promise((resolve) => setTimeout(resolve, 50))
      // Simulate pressing Enter (carriage return)
      stdin.write('\r')

      // Wait a brief moment for the async import and fs call to flush
      await new Promise((resolve) => setTimeout(resolve, 150))

      const frame = lastFrame()
      expect(frame).toBeDefined()
      if (frame) {
        expect(frame).toContain('User ›')
        expect(frame).toContain('/stats')
        expect(frame).toContain('bun-test|TypeError')
        expect(frame).toContain('uncertain') // because total attempts is 1 (< 3 attempts)
      }
    } finally {
      // Clean up
      await fs.rm(testDir, { recursive: true, force: true })
      if (originalMemoryDir === undefined) {
        Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
      } else {
        process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
      }
    }
  })

  it('renders a well-formed <task-notification> message as a compact task-notice line', () => {
    const messages: CanonicalMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              '<task-notification>\n<task_id>shell-ab12cd34</task_id>\n<task_type>shell</task_type>\n' +
              '<status>completed</status>\n<exit_code>0</exit_code>\n' +
              '<output_file>.octonoesis/tasks/shell-ab12cd34.log</output_file>\n' +
              '<summary>Task "bun test" completed (exit code 0)</summary>\n</task-notification>\n' +
              'Last output:\nsome captured stdout that must never reach the frame',
          },
        ],
      },
    ]

    const { lastFrame } = render(<App messages={messages} />)
    const frame = lastFrame()
    expect(frame).toBeDefined()
    if (!frame) return
    expect(frame).toContain('Task ›')
    expect(frame).toContain('shell-ab12cd34')
    expect(frame).toContain('completed')
    expect(frame).toContain('bun test')
    expect(frame).not.toContain('User ›')
    expect(frame).not.toContain('<task-notification>')
    expect(frame).not.toContain('<task_id>')
    expect(frame).not.toContain('Last output:')
    expect(frame).not.toContain('some captured stdout')
  })

  it('falls back to a generic label for a malformed <task-notification> message', () => {
    const messages: CanonicalMessage[] = [
      { role: 'user', content: '<task-notification>\nnot well-formed, no closing tags at all' },
    ]

    const { lastFrame } = render(<App messages={messages} />)
    const frame = lastFrame()
    expect(frame).toBeDefined()
    if (!frame) return
    expect(frame).toContain('Task › background task update')
    expect(frame).not.toContain('User ›')
    expect(frame).not.toContain('<task-notification>')
  })

  it('still renders an ordinary user message as a User › bubble, unaffected', () => {
    const messages: CanonicalMessage[] = [
      { role: 'user', content: 'a completely ordinary message, not a task notice' },
    ]

    const { lastFrame } = render(<App messages={messages} />)
    const frame = lastFrame()
    expect(frame).toBeDefined()
    if (!frame) return
    expect(frame).toContain('User ›')
    expect(frame).toContain('a completely ordinary message, not a task notice')
    expect(frame).not.toContain('Task ›')
  })
})

describe('formatTaskNoticeLabel', () => {
  it('truncates a long summary to at most 80 characters with an ellipsis', () => {
    const longSummary = `Task "bun test with a very long command line" completed ${'x'.repeat(60)}`
    const text = `<task-notification>\n<task_id>agent-1</task_id>\n<status>completed</status>\n<summary>${longSummary}</summary>\n</task-notification>`

    const label = formatTaskNoticeLabel(text)

    expect(label.startsWith('Task › agent-1 completed: ')).toBe(true)
    const renderedSummary = label.slice('Task › agent-1 completed: '.length)
    expect(renderedSummary.length).toBeLessThan(81)
    expect(renderedSummary.endsWith('…')).toBe(true)
  })

  it('falls back to the generic label when task_id is missing', () => {
    const text =
      '<task-notification>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>'
    expect(formatTaskNoticeLabel(text)).toBe('Task › background task update')
  })

  it('falls back to the generic label when status is missing', () => {
    const text =
      '<task-notification>\n<task_id>agent-1</task_id>\n<summary>done</summary>\n</task-notification>'
    expect(formatTaskNoticeLabel(text)).toBe('Task › background task update')
  })

  it('falls back to the generic label when summary is missing', () => {
    const text =
      '<task-notification>\n<task_id>agent-1</task_id>\n<status>completed</status>\n</task-notification>'
    expect(formatTaskNoticeLabel(text)).toBe('Task › background task update')
  })

  it('falls back to the generic label for text that is not a task notification', () => {
    expect(formatTaskNoticeLabel('just a normal user message')).toBe(
      'Task › background task update',
    )
  })
})
