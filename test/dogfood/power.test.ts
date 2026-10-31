import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { clusterPlanningPower, planPower } from './power'
import { preregister } from './run'
import { families } from './tasks'

test('default +5pp cluster power target is minimal integer allocation and responds to assumptions', () => {
  const design = planPower({ families: families.length })
  expect(design.mde).toBe(0.05)
  expect(design.alpha).toBe(0.05)
  expect(design.power).toBe(0.8)
  expect(design.design_effect).toBe(2)
  expect(design.computed_power).toBeGreaterThan(0.8)
  expect(clusterPlanningPower(design.computed_pairs_per_family - 1, design)).toBeLessThan(0.8)
  expect(planPower({ families: families.length, mde: 0.1 }).computed_pairs_per_family).toBeLessThan(
    design.computed_pairs_per_family,
  )
  expect(
    planPower({ families: families.length, design_effect: 4 }).computed_pairs_per_family,
  ).toBeGreaterThan(design.computed_pairs_per_family)
  expect(
    planPower({ families: families.length, discordance: 0.25 }).computed_pairs_per_family,
  ).toBeLessThan(design.computed_pairs_per_family)
  expect(planPower({ families: families.length * 2 }).computed_pairs).toBeLessThan(
    design.computed_pairs,
  )
  // With no effect, the integrated central-t rejection probability is alpha.
  expect(clusterPlanningPower(1, { ...design, mde: 0 })).toBeCloseTo(0.05, 6)
  for (const input of [
    { mde: 0 },
    { mde: Number.NaN },
    { mde: 0.6 },
    { discordance: 0 },
    { discordance: 2 },
    { design_effect: 0.5 },
    { alpha: 0 },
    { power: 1 },
    { families: 2 },
  ])
    expect(() => planPower({ families: families.length, ...input })).toThrow()
})

test('preregistration freezes power assumptions, computed and scheduled allocations, and rejects changed resume', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dogfood-power-'))
  const liveDir = await mkdtemp(path.join(os.tmpdir(), 'dogfood-power-live-'))
  try {
    const options = {
      dryRun: true,
      streamSeed: 4,
      pairsPerFamily: 7,
      mde: 0.05,
      discordance: 0.4,
      designEffect: 3,
    }
    const plan = await preregister(dir, options)
    const retained = JSON.parse(await readFile(path.join(dir, 'preregistration.json'), 'utf8'))
    expect(retained.power_design).toEqual(plan.power_design)
    expect(plan.sample_size.pairs).toBe(7 * families.length)
    expect(plan.power_design.scheduled_pairs_per_family).toBe(7)
    expect(plan.power_design.scheduled_pairs).toBe(7 * families.length)
    expect(plan.power_design.meets_planning_target).toBe(false)
    expect(plan.power_design.computed_pairs).toBe(
      plan.power_design.computed_pairs_per_family * families.length,
    )
    expect(plan.test).toContain('family-cluster SE')
    expect(plan.test).toContain('Secondary: exact McNemar')
    expect(await preregister(dir, options)).toEqual(plan)
    for (const changed of [
      { pairsPerFamily: 8 },
      { mde: 0.06 },
      { discordance: 0.5 },
      { designEffect: 2 },
    ])
      await expect(preregister(dir, { ...options, ...changed })).rejects.toThrow('Resume')
    const live = await preregister(liveDir, { model: 'source-pinned-test' })
    expect(live.sample_size.pairs).toBe(live.power_design.computed_pairs)
    expect(live.power_design.meets_planning_target).toBe(true)
    for (const family of families)
      expect(live.tasks.filter((t) => t.family === family && t.split === 'heldout').length).toBe(
        live.power_design.computed_pairs_per_family,
      )
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(liveDir, { recursive: true, force: true })
  }
})
