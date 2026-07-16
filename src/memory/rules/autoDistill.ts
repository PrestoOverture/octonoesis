import path from 'node:path'
import { getCheapestModel } from '../../providers/index.ts'
import { dbg } from '../../utils/debug.ts'
import { getMemoryDir } from '../../utils/path.ts'
import { readEpisodes } from '../episodes/store.ts'
import type { Episode } from '../episodes/types.ts'
import { distillEpisode } from './distill.ts'
import { updateLifecycle } from './lifecycle.ts'
import { enforcePoolCap } from './pool.ts'
import { loadAllRules, saveRule } from './store.ts'
import type { RuleFile } from './types.ts'

export const AUTO_DISTILL_MAX_CALLS_PER_SESSION = 3
export const AUTO_DISTILL_MIN_VALUE_SCORE = 0
export const AUTO_DISTILL_EXTRACTOR_VERSION = '0.2.0'

export interface AutoDistillOptions {
  memoryDir?: string
  maxCalls?: number
  model?: string
  extractorVersion?: string
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
  const rules = await loadAllRules(rulesDir)
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
  const maxCalls = Math.max(0, Math.floor(options.maxCalls ?? AUTO_DISTILL_MAX_CALLS_PER_SESSION))
  let distillCalls = 0
  let changed = false

  for (const episode of episodes) {
    if (
      evidencedEpisodeIds.has(episode.id) ||
      initiallyCoveredSignatures.has(episode.failure.signature)
    ) {
      continue
    }

    const existingRule = rules.find((rule) =>
      rule.triggers.error_signatures.includes(episode.failure.signature),
    )
    if (existingRule) {
      existingRule.evidence.push(episode.id)
      existingRule.alpha = 2 + existingRule.hits + existingRule.evidence.length
      existingRule.beta = 2 + existingRule.misses
      await updateLifecycle(existingRule, repoRoot)
      evidencedEpisodeIds.add(episode.id)
      changed = true
      continue
    }

    if (distillCalls >= maxCalls) continue
    distillCalls++

    try {
      const rule = await distillEpisode(episode, {
        model: options.model ?? getCheapestModel(),
        extractorVersion: options.extractorVersion ?? AUTO_DISTILL_EXTRACTOR_VERSION,
      })
      await updateLifecycle(rule, repoRoot)
      rules.push(rule)
      evidencedEpisodeIds.add(episode.id)
      changed = true
    } catch (error) {
      dbg('memory', `Failed to auto-distill episode ${episode.id}`, error)
    }
  }

  if (!changed) return

  for (const rule of enforcePoolCap(rules)) {
    await saveRule(rule, rulesDir)
  }
}
