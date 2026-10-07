import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { version as packageVersion } from '../../../package.json'
import type { CalibrationRecord } from '../../../src/memory/calibration/stats'
import type { Episode } from '../../../src/memory/episodes/types'
import { loadFitnessInput } from '../../../src/memory/fitness/io'
import { serializeRule } from '../../../src/memory/rules/store'
import type { RuleFile } from '../../../src/memory/rules/types'
import { bannerLines, fitnessLines, version } from '../../../src/ui/banner'

const now = new Date('2026-01-05T12:00:00Z')
function records(count: number, ts: string): CalibrationRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    session_id: `${ts}-${index}`,
    ts,
    bucket_key: 'test',
    model_id: 'test',
    attempt_count: 1,
    first_attempt_success: true,
    user_modifications: 0,
    user_reverts: 0,
    resolved: true,
  }))
}
test('empty directory hides ledger and trend; disk fixture counts and ISO week thresholds', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'banner-fitness-'))
  try {
    expect(fitnessLines(await loadFitnessInput(directory), now)).toEqual([])
    const rule: RuleFile = {
      id: 'rule-test',
      triggers: { tools: [], command_prefix: [], error_signatures: [] },
      scope: 'repo',
      alpha: 2,
      beta: 2,
      confidence: 0.5,
      evidence: [],
      hits: 0,
      misses: 0,
      challenged_by: [],
      anchor: { file: 'fixture' },
      status: 'active',
      user_confirmed: true,
      extractor_version: 'test',
      model_id: 'test',
      prompt_hash: 'test',
      created_at: now.toISOString(),
      last_matched_at: null,
      last_rebuilt_at: null,
      advice: 'fixture rule',
    }
    const episode: Episode = {
      id: 'ep_1',
      timestamp: now.toISOString(),
      session_id: 'test',
      task_digest: 'test',
      failure: { tool: 'Bash', cmd: 'test', error_class: 'test', signature: 'test' },
      fix_candidates: [],
      attribution: { status: 'unattributable', confidence: 0 },
      outcome: 'abandoned',
      journal_line_range: { start: 1, end: 1 },
      value_score: 0,
      is_excluded: false,
      exclusion_reason: null,
    }
    await fs.mkdir(path.join(directory, 'rules'))
    await fs.writeFile(path.join(directory, 'rules/rule-test.md'), serializeRule(rule))
    await fs.writeFile(path.join(directory, 'episodes.jsonl'), JSON.stringify(episode))
    const input = await loadFitnessInput(directory)
    expect(fitnessLines(input, now)).toEqual(['1 active rules · 1 episodes'])
    for (const [current, previous, visible] of [
      [9, 10, false],
      [10, 9, false],
      [10, 10, true],
      [11, 11, true],
    ] as const) {
      const data = [
        ...records(current, now.toISOString()),
        ...records(previous, '2025-12-29T12:00:00Z'),
      ]
      await fs.writeFile(
        path.join(directory, 'calibration.jsonl'),
        data.map((record) => JSON.stringify(record)).join('\n'),
      )
      const lines = fitnessLines(await loadFitnessInput(directory), now)
      expect(lines.length).toBe(visible ? 2 : 1)
      if (visible) expect(lines[1]).toBe('First try: 100% this wk / 100% last wk')
    }
    input.calibration_records = [
      ...records(10, '2025-12-15T12:00:00Z'),
      ...records(10, '2025-12-22T12:00:00Z'),
    ]
    expect(fitnessLines(input, now)).toEqual(['1 active rules · 1 episodes'])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
test('CLI and banner share package version', async () => {
  expect(version).toBe(packageVersion)
  expect(bannerLines('model', '/repo')[0]).toBe(`Noe · Octonoesis v${packageVersion}`)
  const result = await promisify(execFile)('bun', ['src/cli.tsx', '--version'])
  expect(result.stdout.trim()).toBe(packageVersion)
})
