import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { RuleFile } from '../memory/rules/types.ts'
import { getMemoryDir } from '../utils/path.ts'
import type { ExperimentRecord } from './schema.ts'

const ASSIGNMENTS_FILE = 'experiment-assignments.jsonl'

/**
 * Deterministically assigns a session to one arm of an experiment: sha256(`${experiment.id}|
 * ${sessionId}`), first 8 hex chars as an integer, mod arm count. Pure — recomputable from
 * just the session id and experiment (no state lookup), so it is safe to call repeatedly
 * within a session and always yields the same arm as long as the experiment's arms are
 * unchanged (preregistration immutability guarantees this once the experiment is running).
 * @param sessionId The session id to assign.
 * @param experiment The experiment being assigned into; must declare at least one arm.
 * @returns The assigned arm's name.
 */
export function assignArm(sessionId: string, experiment: ExperimentRecord): string {
  const arms = experiment.arms
  if (!arms || arms.length === 0) {
    throw new Error(`Experiment ${experiment.id} has no arms to assign`)
  }
  const hash = createHash('sha256').update(`${experiment.id}|${sessionId}`).digest('hex')
  const index = Number.parseInt(hash.slice(0, 8), 16) % arms.length
  const arm = arms[index]
  if (!arm) {
    throw new Error(`Experiment ${experiment.id} arm resolution failed for index ${index}`)
  }
  return arm.name
}

/**
 * Filters a rule pool down to what one arm of a session should see. A rule whose
 * `prompt_hash` is claimed by at least one arm is kept only when the given arm claims it;
 * rules whose `prompt_hash` is claimed by no arm always pass through. Never mutates the
 * input array. When two arms claim identical prompt_hash sets (an A/A experiment), both
 * arms resolve to the same filtered pool by construction.
 * @param rules The full rule pool to filter.
 * @param experiment The experiment whose arms define the claimed prompt_hash sets.
 * @param armName The session's assigned arm name.
 * @returns A new array containing only the rules visible to armName.
 */
export function filterRulesForArm(
  rules: readonly RuleFile[],
  experiment: ExperimentRecord,
  armName: string,
): RuleFile[] {
  const arms = experiment.arms ?? []
  const claimedHashes = new Set<string>()
  let ownedHashes: ReadonlySet<string> = new Set()
  for (const arm of arms) {
    for (const hash of arm.prompt_hashes) claimedHashes.add(hash)
    if (arm.name === armName) ownedHashes = new Set(arm.prompt_hashes)
  }

  return rules.filter(
    (rule) => !claimedHashes.has(rule.prompt_hash) || ownedHashes.has(rule.prompt_hash),
  )
}

export interface AssignmentRecordInput {
  session_id: string
  experiment_id: string
  arm: string
}

/**
 * Appends one arm-assignment record to `experiment-assignments.jsonl` for honest post-hoc
 * analysis. Creates the memory dir and file on first write.
 * @param input The session/experiment/arm being recorded.
 * @param memoryDir Optional override for the persistent-data root.
 */
export async function recordAssignment(
  input: AssignmentRecordInput,
  memoryDir: string = getMemoryDir(),
): Promise<void> {
  await fs.mkdir(memoryDir, { recursive: true })
  const record = {
    schema_version: 1,
    ts: new Date().toISOString(),
    session_id: input.session_id,
    experiment_id: input.experiment_id,
    arm: input.arm,
  }
  await fs.appendFile(path.join(memoryDir, ASSIGNMENTS_FILE), `${JSON.stringify(record)}\n`, 'utf8')
}
