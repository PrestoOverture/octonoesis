import assert from 'node:assert/strict'
import type { CanonicalMessage } from '../../src/providers/types'
import { type CompactResult, createCompactSummaryMessage } from '../../src/query/compact'

/** Explicit task-level expectations, independent of the summarizer's own judgement. */
export interface CompactionQualityContract {
  summaryLiterals: string[]
  historyLiterals?: string[]
  forbiddenSummaryLiterals?: string[]
  continuationLiterals: string[]
}

export function evaluateCompactionQuality(
  result: CompactResult,
  contract: CompactionQualityContract,
  continuation?: string,
): void {
  assert.ok(result.postCompactTokens < result.preCompactTokens, 'Context must shrink')
  for (const literal of contract.summaryLiterals) {
    assert.ok(result.summary.includes(literal), `Summary lost required fact: ${literal}`)
  }
  for (const literal of contract.forbiddenSummaryLiterals ?? []) {
    assert.ok(!result.summary.includes(literal), `Summary introduced a forbidden claim: ${literal}`)
  }
  const history = [
    result.pinnedHead,
    createCompactSummaryMessage(result.summary),
    ...result.messagesKept,
  ]
  const renderedHistory = JSON.stringify(history)
  for (const literal of contract.historyLiterals ?? []) {
    assert.ok(renderedHistory.includes(literal), `History lost required constraint: ${literal}`)
  }
  assertPairedHistory(history)
  if (continuation !== undefined) {
    for (const literal of contract.continuationLiterals) {
      assert.ok(continuation.includes(literal), `Continuation lost required fact: ${literal}`)
    }
  }
}

export function assertPairedHistory(messages: CanonicalMessage[]): void {
  const pending = new Set<string>()
  const seen = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      assert.equal(
        pending.size,
        0,
        'Previous tool calls must be answered before the next assistant turn',
      )
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue
        assert.ok(!seen.has(block.id), `Duplicate tool call: ${block.id}`)
        pending.add(block.id)
        seen.add(block.id)
      }
    } else if (message.role === 'tool') {
      assert.ok(pending.delete(message.tool_use_id), `Unpaired tool result: ${message.tool_use_id}`)
    } else assert.equal(pending.size, 0, 'User message split a tool call/result group')
  }
  assert.equal(pending.size, 0, 'Compacted history contains unanswered tool calls')
}
