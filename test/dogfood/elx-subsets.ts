/**
 * ELX nested training subsets: splits the assembled dataset into LoRA-100 ⊂ LoRA-300 ⊂ LoRA-800,
 * stratified by family, plus a reserve of the remaining sessions. Selection depends only on the
 * session keys and the fixed seed, never on outcomes or file order.
 *
 *   bun test/dogfood/elx-subsets.ts --in <dataset.jsonl> --out <dir>
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Command } from 'commander'

export const ELX_SUBSET_SEED = 20261124
export const ELX_SUBSET_SIZES = [800, 300, 100] as const
export const ELX_FAMILY_FLOOR = 40

export interface SessionRef {
  key: string
  family: string
}

export interface SubsetPlan {
  seed: number
  /** Session keys per subset size, in rank order. */
  subsets: Record<string, string[]>
  reserve: string[]
  perFamily: Record<string, Record<string, number>>
}

/**
 * Largest-remainder allocation of `total` across `parent`, never exceeding a parent count.
 * Each family first receives `floor` sessions (or all it has); the rest is proportional.
 */
export function allocate(
  parent: Record<string, number>,
  total: number,
  floor = 0,
): Record<string, number> {
  const families = Object.keys(parent).sort()
  const sum = families.reduce((acc, family) => acc + (parent[family] as number), 0)
  if (total > sum) throw new Error(`Cannot take ${total} sessions from ${sum}`)
  const base = (family: string) => Math.min(parent[family] as number, floor)
  const baseSum = families.reduce((acc, family) => acc + base(family), 0)
  if (baseSum > total) throw new Error(`Floor ${floor} needs ${baseSum} of ${total} sessions`)
  const spare = sum - baseSum
  const shares = families.map((family) => {
    const room = (parent[family] as number) - base(family)
    const exact = spare === 0 ? 0 : (room * (total - baseSum)) / spare
    return {
      family,
      count: base(family) + Math.floor(exact),
      remainder: exact - Math.floor(exact),
    }
  })
  let left = total - shares.reduce((acc, share) => acc + share.count, 0)
  const order = [...shares].sort(
    (a, b) => b.remainder - a.remainder || a.family.localeCompare(b.family),
  )
  for (const share of order) {
    if (left === 0) break
    share.count++
    left--
  }
  return Object.fromEntries(shares.map((share) => [share.family, share.count]))
}

function rank(key: string, seed: number): string {
  return createHash('sha256').update(`${seed}:${key}`).digest('hex')
}

/** Builds nested, family-stratified subsets. Sizes must be strictly descending. */
export function planSubsets(
  sessions: SessionRef[],
  sizes: readonly number[] = ELX_SUBSET_SIZES,
  seed = ELX_SUBSET_SEED,
  familyFloor = ELX_FAMILY_FLOOR,
): SubsetPlan {
  if (new Set(sessions.map((s) => s.key)).size !== sessions.length)
    throw new Error('Duplicate session keys')
  if (sizes.some((size, i) => i > 0 && size >= (sizes[i - 1] as number)))
    throw new Error('Subset sizes must be strictly descending')
  const byFamily = new Map<string, string[]>()
  for (const { key, family } of sessions)
    byFamily.set(family, [...(byFamily.get(family) ?? []), key])
  for (const keys of byFamily.values())
    keys.sort((a, b) => rank(a, seed).localeCompare(rank(b, seed)))

  const subsets: SubsetPlan['subsets'] = {}
  const perFamily: SubsetPlan['perFamily'] = {}
  let parent = Object.fromEntries([...byFamily].map(([family, keys]) => [family, keys.length]))
  for (const [index, size] of sizes.entries()) {
    // The design's ≥ 40 per family applies to the full training set only.
    const counts = allocate(parent, size, index === 0 ? familyFloor : 0)
    subsets[size] = Object.keys(counts)
      .sort()
      .flatMap((family) => (byFamily.get(family) as string[]).slice(0, counts[family]))
    perFamily[size] = counts
    parent = counts
  }
  const largest = new Set(subsets[sizes[0] as number])
  const reserve = sessions
    .map((s) => s.key)
    .filter((key) => !largest.has(key))
    .sort()
  return { seed, subsets, reserve, perFamily }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

if (import.meta.main) {
  const { in: input, out } = new Command()
    .name('bun test/dogfood/elx-subsets.ts')
    .requiredOption('--in <file>', 'Assembled dataset JSONL')
    .requiredOption('--out <dir>', 'Output directory')
    .parse(process.argv)
    .opts<{ in: string; out: string }>()
  const text = await readFile(input, 'utf8')
  const lines = text.split('\n').filter(Boolean)
  const linesByKey = new Map<string, string[]>()
  const families = new Map<string, string>()
  for (const line of lines) {
    const { meta } = JSON.parse(line)
    const key = `${meta.run}/${meta.session}`
    linesByKey.set(key, [...(linesByKey.get(key) ?? []), line])
    families.set(key, meta.family)
  }
  const plan = planSubsets([...families].map(([key, family]) => ({ key, family })))
  await mkdir(out, { recursive: true, mode: 0o700 })
  const files: Record<string, { sessions: number; samples: number; sha256: string }> = {}
  const emit = async (name: string, keys: string[]) => {
    const selected = keys.flatMap((key) => linesByKey.get(key) as string[])
    const body = `${selected.join('\n')}\n`
    await writeFile(path.join(out, name), body, { mode: 0o600 })
    files[name] = { sessions: keys.length, samples: selected.length, sha256: sha256(body) }
  }
  for (const size of ELX_SUBSET_SIZES)
    await emit(`lora-${size}.jsonl`, plan.subsets[size] as string[])
  await emit('reserve.jsonl', plan.reserve)
  const manifest = {
    source_sha256: sha256(text),
    seed: plan.seed,
    files,
    per_family: plan.perFamily,
    subsets: plan.subsets,
    reserve: plan.reserve,
  }
  await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  })
  console.log(
    JSON.stringify({ source_sha256: manifest.source_sha256, files, per_family: plan.perFamily }),
  )
}
