import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { getCheapestModel } from '../../providers/index.ts'
import { getRepoRoot } from '../../utils/path.ts'
import { readEpisodes } from '../episodes/store.ts'
import { distillEpisode } from './distill.ts'
import { updateLifecycle } from './lifecycle.ts'
import { enforcePoolCap } from './pool.ts'
import { getRulesDir, loadAllRules, saveRule } from './store.ts'
import type { RuleFile } from './types.ts'

/**
 * Rebuilds all rules from episodes.jsonl, preserving metrics & user status modifications.
 * @param episodesPath Path to the episodes JSONL file.
 * @param rulesDir Directory path where rule markdown files are stored.
 * @param ctx The extraction execution context.
 */
export async function rebuildRules(
  episodesPath: string, // Passed for API compatibility, readEpisodes determines path internally
  rulesDir: string,
  ctx: { model?: string; extractorVersion: string; forceDistill?: boolean },
): Promise<void> {
  const repoRoot = getRepoRoot()
  const modelToUse = ctx.model || getCheapestModel()

  // 1. Load existing rules to preserve metrics (hits, misses) and user status modifications (pinned, banned)
  const existingRules = await loadAllRules(rulesDir)
  const existingRulesMap = new Map<string, RuleFile>()
  for (const r of existingRules) {
    const sig = r.triggers.error_signatures[0]
    if (sig) {
      existingRulesMap.set(sig, r)
    }
  }

  // 2. Read all episodes
  const episodes = await readEpisodes(episodesPath)
  const eligibleEpisodes = episodes.filter((ep) => !ep.is_excluded)

  // Sort episodes chronologically
  eligibleEpisodes.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  // 3. Clear rules directory (delete all rule-*.md files)
  try {
    const files = await readdir(rulesDir)
    const rulesToDel = files.filter((f) => f.startsWith('rule-') && f.endsWith('.md'))
    for (const f of rulesToDel) {
      await rm(path.join(rulesDir, f), { force: true })
    }
  } catch {
    await mkdir(rulesDir, { recursive: true })
  }

  const rebuiltRules: RuleFile[] = []

  for (const episode of eligibleEpisodes) {
    const sig = episode.failure.signature

    // Check if we've already created a rule for this signature in the current rebuild list
    const existingRebuiltRule = rebuiltRules.find((r) => r.triggers.error_signatures.includes(sig))
    if (existingRebuiltRule) {
      if (!existingRebuiltRule.evidence.includes(episode.id)) {
        existingRebuiltRule.evidence.push(episode.id)
        existingRebuiltRule.alpha =
          2 + existingRebuiltRule.hits + existingRebuiltRule.evidence.length
      }
      continue
    }

    // Check if we can reuse an existing rule from disk
    const preExistingRule = existingRulesMap.get(sig)
    if (preExistingRule && !ctx.forceDistill) {
      const ruleCopy: RuleFile = {
        ...preExistingRule,
        evidence: [episode.id],
        last_rebuilt_at: new Date().toISOString(),
      }
      ruleCopy.alpha = 2 + ruleCopy.hits + ruleCopy.evidence.length
      ruleCopy.beta = 2 + ruleCopy.misses
      rebuiltRules.push(ruleCopy)
    } else {
      const newRule = await distillEpisode(episode, {
        model: modelToUse,
        extractorVersion: ctx.extractorVersion,
      })

      // Preserve stats and user modifications
      if (preExistingRule) {
        newRule.hits = preExistingRule.hits
        newRule.misses = preExistingRule.misses
        newRule.alpha = 2 + newRule.hits + newRule.evidence.length
        newRule.beta = 2 + newRule.misses
        newRule.challenged_by = preExistingRule.challenged_by
        newRule.user_confirmed = preExistingRule.user_confirmed
        newRule.last_matched_at = preExistingRule.last_matched_at
        if (
          preExistingRule.status === 'active' ||
          preExistingRule.status === 'pinned' ||
          preExistingRule.status === 'banned' ||
          preExistingRule.status === 'superseded' ||
          preExistingRule.user_confirmed
        ) {
          newRule.status = preExistingRule.status
        }
      }

      newRule.last_rebuilt_at = new Date().toISOString()
      rebuiltRules.push(newRule)
    }
  }

  // 4. Update lifecycle states
  for (let i = 0; i < rebuiltRules.length; i++) {
    const r = rebuiltRules[i]
    if (r) {
      rebuiltRules[i] = await updateLifecycle(r, repoRoot)
    }
  }

  // 5. Enforce pool cap
  const finalRules = enforcePoolCap(rebuiltRules)

  // 6. Save rules back to disk
  for (const rule of finalRules) {
    await saveRule(rule, rulesDir)
  }
}
