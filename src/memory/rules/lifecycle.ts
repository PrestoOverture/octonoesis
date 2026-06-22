import fs from 'node:fs/promises'
import { join } from 'node:path'
import { credibleInterval } from '../calibration/beta.ts'
import type { RuleFile } from './types.ts'
import { calculateConfidence } from './types.ts'

/**
 * Checks if the anchor file exists and is a valid file.
 */
export async function checkAnchorValid(anchorFile: string, repoRoot: string): Promise<boolean> {
  if (!anchorFile) return false
  try {
    const fullPath = join(repoRoot, anchorFile)
    const stat = await fs.stat(fullPath)
    return stat.isFile()
  } catch {
    return false
  }
}

/**
 * Updates the rule's lifecycle status, recomputes confidence, and executes validation checks.
 */
export async function updateLifecycle(rule: RuleFile, repoRoot: string): Promise<RuleFile> {
  // Re-calculate confidence
  rule.confidence = calculateConfidence(rule.alpha, rule.beta)

  // If status is pinned or banned, it is user-controlled and immune to demotion
  if (rule.status === 'pinned' || rule.status === 'banned') {
    return rule
  }

  // Anchor check: active or candidate rules are retired if the anchor file is missing
  const anchorValid = await checkAnchorValid(rule.anchor.file, repoRoot)
  if (!anchorValid) {
    rule.status = 'retired'
    return rule
  }

  const [lower, upper] = credibleInterval(rule, 0.95)

  // Active -> Retired if 95% CI upper bound < 0.45
  if (rule.status === 'active' && upper < 0.45) {
    rule.status = 'retired'
    return rule
  }

  // Candidate -> Active if posterior mean >= 0.55 AND 95% CI lower bound > 0.3 OR user_confirmed is true
  if (rule.status === 'candidate') {
    if (rule.user_confirmed || (rule.confidence >= 0.55 && lower > 0.3)) {
      rule.status = 'active'
    }
  }

  // Active -> Dormant if 90 days of no trigger match (no hits / last_matched_at is old)
  const lastActiveStr = rule.last_matched_at || rule.created_at
  const lastActive = new Date(lastActiveStr).getTime()
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000
  if (rule.status === 'active' && Date.now() - lastActive > ninetyDaysMs) {
    rule.status = 'dormant'
  }

  return rule
}
