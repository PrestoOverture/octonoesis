import { estimateTextTokens as estimateTokens } from '../utils/tokens'

export { estimateTokens }

export type ContextPriority = 'critical' | 'high' | 'medium' | 'low'

export interface ContextSource {
  id: string
  channel: 'systemStable' | 'preamble'
  priority: ContextPriority
  content: string
  tokens?: number
}

export interface ContextBudget {
  totalSystemPromptCap: number
  perSourceCaps: Record<string, number>
}

export interface CompiledContext {
  systemStable: string
  preamble: string
  totalTokens: number
  dropped: string[]
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  totalSystemPromptCap: 32_000,
  perSourceCaps: {
    static_prompt: 8_000,
    claude_md: 12_000,
    memory_index: 4_000,
    relevant_memories: 4_000,
    active_rules: 2_000,
    skill_catalog: 2_000,
    mcp_instructions: 2_000,
    dynamic_suffix: 1_000,
  },
}

export class ContextBudgetError extends Error {
  constructor(sourceIds: string[]) {
    super(`Critical context sources exceed totalSystemPromptCap: ${sourceIds.join(', ')}`)
    this.name = 'ContextBudgetError'
  }
}

interface PreparedSource extends ContextSource {
  included: boolean
  budgetTokens: number
  usesTokenOverride: boolean
}

export function compileContext(sources: ContextSource[], budget: ContextBudget): CompiledContext {
  const droppedIds = new Set<string>()
  const preparedSources = sources
    .filter((source) => source.content.length > 0)
    .map<PreparedSource>((source) => {
      const cap = budget.perSourceCaps[source.id]
      const tokens = source.tokens ?? estimateTokens(source.content)

      if (cap !== undefined && tokens > cap) {
        droppedIds.add(source.id)
        const content = source.content.slice(0, cap * 4)
        return {
          ...source,
          content,
          included: true,
          budgetTokens: Math.min(cap, estimateTokens(content)),
          usesTokenOverride: false,
        }
      }

      return {
        ...source,
        included: true,
        budgetTokens: tokens,
        usesTokenOverride: source.tokens !== undefined,
      }
    })

  const includedSources = (candidates: PreparedSource[]): PreparedSource[] =>
    candidates.filter((source) => source.included && source.content.length > 0)

  const buildSources = (candidates: PreparedSource[]): string =>
    includedSources(candidates)
      .map((source) => source.content)
      .join('\n\n')

  const countSources = (candidates: PreparedSource[]): number => {
    const included = includedSources(candidates)
    const content = buildSources(included)
    const estimationAdjustment = included.reduce(
      (total, source) => total + source.budgetTokens - estimateTokens(source.content),
      0,
    )
    return Math.max(0, estimateTokens(content) + estimationAdjustment)
  }

  const channelSources = (channel: ContextSource['channel']): PreparedSource[] =>
    preparedSources.filter((source) => source.channel === channel)

  const systemSources = channelSources('systemStable')
  const exceedsSystemCap = (): boolean => countSources(systemSources) > budget.totalSystemPromptCap

  const criticalSources = systemSources.filter((source) => source.priority === 'critical')
  const criticalContributors = includedSources(criticalSources)

  if (countSources(criticalContributors) > budget.totalSystemPromptCap) {
    throw new ContextBudgetError([...new Set(criticalContributors.map((source) => source.id))])
  }

  const dropPriority = (priority: 'low' | 'medium'): void => {
    const candidates = preparedSources
      .filter((source) => source.channel === 'systemStable' && source.priority === priority)
      .reverse()

    for (const source of candidates) {
      if (!exceedsSystemCap()) break
      source.included = false
      droppedIds.add(source.id)
    }
  }

  dropPriority('low')
  dropPriority('medium')

  const highSources = preparedSources
    .filter((source) => source.channel === 'systemStable' && source.priority === 'high')
    .reverse()

  for (const source of highSources) {
    if (!exceedsSystemCap()) break

    const originalContent = source.content
    const originalBudgetTokens = source.budgetTokens
    const usesTokenOverride = source.usesTokenOverride
    const setPrefix = (length: number): void => {
      source.content = originalContent.slice(0, length)
      source.budgetTokens = usesTokenOverride
        ? Math.ceil((originalBudgetTokens * length) / originalContent.length)
        : estimateTokens(source.content)
    }
    let minLength = 0
    let maxLength = originalContent.length
    let bestLength = -1

    while (minLength <= maxLength) {
      const length = Math.floor((minLength + maxLength) / 2)
      setPrefix(length)

      if (exceedsSystemCap()) {
        maxLength = length - 1
      } else {
        bestLength = length
        minLength = length + 1
      }
    }

    setPrefix(Math.max(0, bestLength))
    droppedIds.add(source.id)
  }

  const systemStable = buildSources(systemSources)
  const preamble = buildSources(channelSources('preamble'))
  const reportedIds = new Set<string>()
  const dropped = sources.flatMap((source) => {
    if (!droppedIds.has(source.id) || reportedIds.has(source.id)) return []
    reportedIds.add(source.id)
    return [source.id]
  })

  return {
    systemStable,
    preamble,
    totalTokens: estimateTokens(systemStable) + estimateTokens(preamble),
    dropped,
  }
}
