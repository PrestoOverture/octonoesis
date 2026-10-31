/** Student-t tails via the regularized incomplete beta continued fraction. */
function logGamma(z: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
    12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
  ]
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z)
  const x = z - 1
  let sum = 0.9999999999998099
  for (let i = 0; i < coefficients.length; i++) sum += (coefficients[i] as number) / (x + i + 1)
  const t = x + 7.5
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(sum)
}
function betaFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300
  let c = 1
  let d = 1 - ((a + b) * x) / (a + 1)
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  let h = d
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < 3e-14) return h
  }
  throw new Error('Student-t beta fraction failed to converge')
}
export function studentTwoSided(t: number, df: number): number {
  if (!Number.isInteger(df) || df < 1 || Number.isNaN(t))
    throw new Error('Invalid Student-t arguments')
  const x = df / (df + t * t)
  if (x === 0) return 0
  if (x === 1) return 1
  const a = df / 2
  const b = 0.5
  const factor = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x),
  )
  const result =
    x < (a + 1) / (a + b + 2)
      ? (factor * betaFraction(a, b, x)) / a
      : 1 - (factor * betaFraction(b, a, 1 - x)) / b
  return Math.max(0, Math.min(1, result))
}
export function studentCritical(df: number, alpha = 0.05): number {
  if (!(alpha > 0 && alpha < 1)) throw new Error('Invalid alpha')
  let low = 0
  let high = 1
  while (studentTwoSided(high, df) > alpha) high *= 2
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2
    if (studentTwoSided(mid, df) > alpha) low = mid
    else high = mid
  }
  return (low + high) / 2
}
