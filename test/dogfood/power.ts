import { studentCritical } from './distributions'

export interface PowerAssumptions {
  mde: number
  alpha: number
  power: number
  discordance: number
  design_effect: number
  families: number
}
export const DEFAULT_POWER = {
  mde: 0.05,
  alpha: 0.05,
  power: 0.8,
  discordance: 0.5,
  design_effect: 2,
} as const

function normalCDF(x: number): number {
  // Standard normal CDF (absolute error < 8e-8).
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const tail =
    (Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI)) *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - tail : tail
}

/** Noncentral-t power in the prespecified Gaussian family-mean working model.
 * Paired difference variance is conservatively q (rather than q-delta^2).
 * DE is fixed at the planned cluster size; increasing size with fixed ICC would
 * change DE and must be planned separately, never inferred from held-out data.
 */
export function clusterPlanningPower(
  pairsPerFamily: number,
  assumptions: PowerAssumptions,
): number {
  const { families: g, alpha, mde, discordance: q, design_effect: de } = assumptions
  const df = g - 1
  const critical = studentCritical(df, alpha)
  const noncentral = mde * Math.sqrt((g * pairsPerFamily) / (de * q))
  // Integrate over s=sqrt(chi-square(df)/df). Normalize numerically, avoiding
  // another gamma implementation. The omitted s>8 tail is negligible for df>=2.
  const steps = 2048
  const step = 8 / steps
  let weighted = 0
  let mass = 0
  for (let i = 1; i < steps; i++) {
    const s = i * step
    const density = s ** (df - 1) * Math.exp((-df * s * s) / 2)
    const weight = i % 2 ? 4 : 2
    const rejection = normalCDF(noncentral - critical * s) + normalCDF(-noncentral - critical * s)
    mass += weight * density
    weighted += weight * density * rejection
  }
  return weighted / mass
}
export function planPower(
  input: Partial<Omit<PowerAssumptions, 'families'>> & { families: number },
) {
  const assumptions: PowerAssumptions = { ...DEFAULT_POWER, ...input }
  const { families: g, mde, alpha, power, discordance: q, design_effect: de } = assumptions
  if (!Number.isSafeInteger(g) || g < 3 || g > 1000)
    throw new Error('Power planning requires 3–1000 families')
  if (!Number.isFinite(mde) || mde <= 0 || mde > q || q > 1 || !Number.isFinite(q) || q <= 0)
    throw new Error('MDE must be positive and no greater than discordance <= 1')
  if (!(alpha > 0 && alpha < 1) || !(power > alpha && power < 1) || !Number.isFinite(de) || de < 1)
    throw new Error('Invalid alpha, power or design effect')
  let high = 1
  while (clusterPlanningPower(high, assumptions) < power) {
    high *= 2
    if (high * g > 900000) throw new Error('Computed sample exceeds reserved stream namespace')
  }
  let low = 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (clusterPlanningPower(mid, assumptions) >= power) high = mid
    else low = mid + 1
  }
  return {
    ...assumptions,
    cluster: 'semantic task family',
    allocation: 'equal pairs per family; equal family weights in primary estimand',
    method:
      'noncentral Student-t planning under independent Gaussian family means, G-1 df; numerical chi-square integration; paired variance = discordance',
    computed_pairs_per_family: low,
    computed_pairs: low * g,
    computed_power: clusterPlanningPower(low, assumptions),
    assumptions: [
      'Independent representative family effects, approximately Gaussian with common variance; fixed trained ledger and provider/model.',
      'Design effect applies at the computed cluster size and is assumed, not estimated from held-out outcomes. Under fixed positive ICC, more variants have diminishing returns; more families or independent training histories may be necessary.',
      'No operational errors or calibration exclusions; additional confirmation gates can reduce power. Dry-run and smaller overrides have no 80% power claim.',
    ],
  }
}
export type PowerDesign = ReturnType<typeof planPower> & {
  scheduled_pairs_per_family: number
  scheduled_pairs: number
  scheduled_power: number
  meets_planning_target: boolean
}
