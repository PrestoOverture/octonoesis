import path from 'node:path'
import { getCheapestModel } from '../../providers/index.ts'
import { dbg } from '../../utils/debug.ts'
import { getMemoryDir } from '../../utils/path.ts'
import { readEpisodes } from '../episodes/store.ts'
import type { Episode } from '../episodes/types.ts'
import { distillEpisode } from './distill.ts'
import { disambiguateRuleId } from './identity.ts'
import { updateLifecycle } from './lifecycle.ts'
import { enforcePoolCap } from './pool.ts'
import { archiveRule, loadAllRules, loadAllRulesIncludingArchived, saveRule } from './store.ts'
import type { RuleFile } from './types.ts'

export const AUTO_DISTILL_MAX_CALLS_PER_QUERY_END = 3
/** @deprecated Use AUTO_DISTILL_MAX_CALLS_PER_QUERY_END; retained for API compatibility. */
export const AUTO_DISTILL_MAX_CALLS_PER_SESSION = AUTO_DISTILL_MAX_CALLS_PER_QUERY_END
export const AUTO_DISTILL_MIN_VALUE_SCORE = 0
export const AUTO_DISTILL_EXTRACTOR_VERSION = '0.2.0'

export interface AutoDistillOptions {
  memoryDir?: string
  maxCalls?: number
  model?: string
  extractorVersion?: string
  attemptedEpisodeIds?: Set<string>
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function signatureLevels(signature: string): string[] {
  const parts = signature.split('|')
  const levels = [signature]
  if (parts.length >= 3) levels.push(parts.slice(0, 3).join('|'))
  if (parts.length >= 2) levels.push(parts.slice(0, 2).join('|'))
  return [...new Set(levels)]
}

function ruleCoversSignature(rule: RuleFile, signature: string): boolean {
  return signatureLevels(signature).some((level) => rule.triggers.error_signatures.includes(level))
}

function isTerminalRule(rule: RuleFile): boolean {
  return rule.status === 'retired' || rule.status === 'superseded' || rule.status === 'dormant'
}

function isAutoDistillEligible(episode: Episode): boolean {
  return (
    !episode.is_excluded &&
    episode.outcome === 'resolved' &&
    episode.attribution.status !== 'unattributable' &&
    episode.value_score > AUTO_DISTILL_MIN_VALUE_SCORE
  )
}

/**
 * Incrementally distills eligible episodes produced by one completed session.
 * Existing candidate rules collect equivalent evidence without another LLM call.
 */
export async function runSessionEndAutoDistill(
  sessionId: string,
  repoRoot: string,
  options: AutoDistillOptions = {},
): Promise<void> {
  if (
    isTruthyEnv(process.env.OCTONOESIS_DISABLE_MEMORY) ||
    isTruthyEnv(process.env.OCTONOESIS_DISABLE_AUTO_DISTILL)
  ) {
    return
  }

  const memoryDir = options.memoryDir ?? getMemoryDir()
  const episodes = (await readEpisodes(path.join(memoryDir, 'episodes.jsonl')))
    .filter((episode) => episode.session_id === sessionId && isAutoDistillEligible(episode))
    .sort(
      (a, b) =>
        b.value_score - a.value_score ||
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )

  if (episodes.length === 0) return

  const rulesDir = path.join(memoryDir, 'rules')
  const rules = await loadAllRulesIncludingArchived(rulesDir)
  const evidencedEpisodeIds = new Set(rules.flatMap((rule) => rule.evidence))
  const initiallyCoveredSignatures = new Set(
    episodes
      .filter((episode) =>
        rules.some(
          (rule) =>
            (rule.status === 'active' || rule.status === 'pinned' || rule.status === 'banned') &&
            ruleCoversSignature(rule, episode.failure.signature),
        ),
      )
      .map((episode) => episode.failure.signature),
  )
  const maxCalls = Math.max(0, Math.floor(options.maxCalls ?? AUTO_DISTILL_MAX_CALLS_PER_QUERY_END))
  const attemptedEpisodeIds = options.attemptedEpisodeIds ?? new Set<string>()
  let distillCalls = 0
  const changedRuleIds = new Set<string>()

  for (const episode of episodes) {
    if (
      attemptedEpisodeIds.has(episode.id) ||
      evidencedEpisodeIds.has(episode.id) ||
      initiallyCoveredSignatures.has(episode.failure.signature)
    ) {
      continue
    }

    const existingCandidate = rules.find(
      (rule) =>
        rule.status === 'candidate' &&
        rule.triggers.error_signatures.includes(episode.failure.signature),
    )
    if (existingCandidate) {
      attemptedEpisodeIds.add(episode.id)
      existingCandidate.evidence.push(episode.id)
      existingCandidate.alpha = 2 + existingCandidate.hits + existingCandidate.evidence.length
      existingCandidate.beta = 2 + existingCandidate.misses
      await updateLifecycle(existingCandidate, repoRoot)
      evidencedEpisodeIds.add(episode.id)
      changedRuleIds.add(existingCandidate.id)
      continue
    }

    if (
      rules.some(
        (rule) =>
          isTerminalRule(rule) &&
          rule.triggers.error_signatures.includes(episode.failure.signature),
      )
    ) {
      attemptedEpisodeIds.add(episode.id)
      continue
    }

    if (distillCalls >= maxCalls) continue
    distillCalls++
    attemptedEpisodeIds.add(episode.id)

    try {
      const rule = disambiguateRuleId(
        await distillEpisode(episode, {
          model: options.model ?? getCheapestModel(),
          extractorVersion: options.extractorVersion ?? AUTO_DISTILL_EXTRACTOR_VERSION,
        }),
        episode.failure.signature,
        rules,
      )
      await updateLifecycle(rule, repoRoot)
      rules.push(rule)
      evidencedEpisodeIds.add(episode.id)
      changedRuleIds.add(rule.id)
    } catch (error) {
      dbg('memory', `Failed to auto-distill episode ${episode.id}`, error)
    }
  }

  if (changedRuleIds.size === 0) return

  const statusesBeforeCap = new Map(rules.map((rule) => [rule.id, rule.status]))
  const finalRules = enforcePoolCap(rules)
  // Self-heal sweep: a terminal-status rule that still has a hot-dir file (e.g. left
  // over from before this feature, or from FR-INJ-1's accounting save) gets archived
  // here too, even if this run's distillation/cap pass left it otherwise untouched.
  const hotRuleIds = new Set((await loadAllRules(rulesDir)).map((rule) => rule.id))
  for (const rule of finalRules) {
    if (statusesBeforeCap.get(rule.id) !== rule.status) changedRuleIds.add(rule.id)
    const terminal = isTerminalRule(rule)
    const staleHotCopy = terminal && hotRuleIds.has(rule.id)
    if (!changedRuleIds.has(rule.id) && !staleHotCopy) continue
    if (terminal) {
      await archiveRule(rule, rulesDir)
    } else {
      await saveRule(rule, rulesDir)
    }
  }
}
