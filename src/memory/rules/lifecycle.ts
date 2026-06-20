import fs from 'node:fs/promises'
import { join } from 'node:path'
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
  rule.confidence = calculateConfidence(rule.hits, rule.misses, rule.evidence.length)

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

  // Active -> Retired if confidence is < 0.45
  if (rule.status === 'active' && rule.confidence < 0.45) {
    rule.status = 'retired'
    return rule
  }

  // Candidate -> Active if evidence count >= 2 or user_confirmed is true
  if (rule.status === 'candidate' && (rule.evidence.length >= 2 || rule.user_confirmed)) {
    rule.status = 'active'
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
