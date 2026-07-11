import fs from 'node:fs/promises'
import path from 'node:path'
import type { SessionState } from '../query/types'
import { getMemoryDir } from '../utils/path'

/**
 * stats.jsonl is a derived, non-authoritative convenience view. Each row is rebuildable from the
 * journal plus the pricing table, and readers treat the last row for a session_id as authoritative.
 */

let writeQueue: Promise<void> = Promise.resolve()

export interface SessionStatsExtras {
  priced: boolean
  durationMs: number
  ts?: string
}

export function createSessionState(sessionId: string, model: string): SessionState {
  return {
    sessionId,
    startTime: Date.now(),
    turns: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    costUsd: 0,
    contextUtilization: 0,
    compactCount: 0,
    model,
  }
}

export function appendSessionStats(state: SessionState, extras: SessionStatsExtras): void {
  const statsPath = path.join(getMemoryDir(), 'stats.jsonl')
  const row = {
    ts: extras.ts ?? new Date().toISOString(),
    session_id: state.sessionId,
    model: state.model,
    turns: state.turns,
    usage: { ...state.usage },
    cost_usd: state.costUsd,
    priced: extras.priced,
    context_utilization: state.contextUtilization,
    compact_count: state.compactCount,
    duration_ms: extras.durationMs,
  }
  const line = `${JSON.stringify(row)}\n`

  writeQueue = writeQueue.then(async () => {
    try {
      await fs.mkdir(path.dirname(statsPath), { recursive: true })
      await fs.appendFile(statsPath, line, 'utf8')
    } catch {}
  })
}

export async function flushSessionStats(): Promise<void> {
  await writeQueue
}

export function formatSessionSummary(state: SessionState, priced: boolean): string {
  const cost = priced ? `$${state.costUsd.toFixed(4)}` : 'n/a'
  return `Session summary: ${state.turns.toLocaleString('en-US')} turns | in: ${state.usage.input_tokens.toLocaleString('en-US')} | out: ${state.usage.output_tokens.toLocaleString('en-US')} | cost: ${cost} | compactions: ${state.compactCount.toLocaleString('en-US')}`
}
