import { extractMemories } from '../memory/auto/extract'
import { appendSessionStats } from '../state/session'
import { estimateCost } from '../utils/cost'
import type { HookRegistry } from './registry'

export function registerBuiltinHooks(registry: HookRegistry): void {
  registry.register({
    event: 'stop',
    timeoutMs: 30_000,
    handler: {
      type: 'function',
      fn: async ({ state, queryContext }) => {
        if (state?.system && queryContext) {
          await extractMemories({ system: state.system, messages: state.messages }, queryContext)
        }
        return undefined
      },
    },
  })
  registry.register({
    event: 'session_end',
    handler: {
      type: 'function',
      fn: async ({ queryContext }) => {
        const sessionState = queryContext?.sessionState
        if (!sessionState) return
        const pricing = estimateCost(sessionState.usage, sessionState.model)
        sessionState.costUsd = pricing.costUsd
        appendSessionStats(sessionState, {
          priced: pricing.priced,
          durationMs: Math.max(0, Date.now() - sessionState.startTime),
        })
        return undefined
      },
    },
  })
}
