/**
 * Experience-Layer Experiment (ELX) fixed design constants.
 * The family split and the stream-seed blocks are drawn/fixed here once, before any
 * student run, and must not change afterwards (see the ELX brief, §2).
 */
import { type Family, families } from './tasks'

/** Seed for the one-time 14/6 family shuffle. */
export const ELX_SPLIT_SEED = 20261121

/**
 * Disjoint stream-seed blocks. Seeds 1–6 were used by the RSC runs.
 * generateStream reserves a separate 1e6-wide numeric namespace per stream seed.
 */
export const ELX_STREAM_SEEDS = {
  /** P2 teacher trajectories (training families only). */
  teacher: 7,
  /** P1 student calibration (all 20 families). */
  studentCalibration: 8,
  /** P3 optional development check (training families only). */
  dev: 9,
  /** P4 confirmatory evaluation (all 20 families). */
  evaluation: 10,
} as const

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic Fisher–Yates split of the 20 calibrated families into 14 training / 6 held-out. */
export function elxSplit(seed = ELX_SPLIT_SEED): { train: Family[]; heldout: Family[] } {
  const order = [...families] as Family[]
  const random = mulberry32(seed)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[order[i], order[j]] = [order[j] as Family, order[i] as Family]
  }
  return { train: order.slice(0, 14).sort(), heldout: order.slice(14).sort() }
}

/** Resolves a `--families` value: `elx-train`, `elx-heldout`, or a comma-separated list. */
export function resolveFamilies(value: string): Family[] {
  if (value === 'elx-train') return elxSplit().train
  if (value === 'elx-heldout') return elxSplit().heldout
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  for (const name of names)
    if (!(families as readonly string[]).includes(name)) throw new Error(`Unknown family: ${name}`)
  if (!names.length) throw new Error('Empty family list')
  return names as Family[]
}
