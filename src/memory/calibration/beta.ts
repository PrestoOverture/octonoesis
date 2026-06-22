export interface BetaParams {
  alpha: number
  beta: number
}

/**
 * Creates a weakly informative prior Beta(2, 2).
 */
export function createPrior(): BetaParams {
  return { alpha: 2, beta: 2 }
}

/**
 * Updates Beta parameters with a hit or miss.
 */
export function update(prior: BetaParams, hit: boolean): BetaParams {
  return {
    alpha: prior.alpha + (hit ? 1 : 0),
    beta: prior.beta + (hit ? 0 : 1),
  }
}

/**
 * Calculates the posterior mean of the Beta distribution.
 */
export function posteriorMean(params: BetaParams): number {
  const sum = params.alpha + params.beta
  return sum > 0 ? params.alpha / sum : 0.5
}

// Log factorial cache for choosing combinations stably without overflow
const logFactorialTable: number[] = [0]
function logFactorial(n: number): number {
  if (n <= 1) return 0
  while (logFactorialTable.length <= n) {
    const idx = logFactorialTable.length
    logFactorialTable.push((logFactorialTable[idx - 1] ?? 0) + Math.log(idx))
  }
  return logFactorialTable[n] ?? 0
}

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return Number.NEGATIVE_INFINITY
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k)
}

/**
 * Computes the Regularized Incomplete Beta function I_x(a, b) for integers a, b.
 * Uses exact Binomial sum expansion:
 * I_x(a, b) = Sum_{j=a}^{a+b-1} choose(a+b-1, j) * x^j * (1-x)^(a+b-1-j)
 */
export function betaInc(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1

  const roundA = Math.round(a)
  const roundB = Math.round(b)
  const n = roundA + roundB - 1

  let sum = 0
  for (let j = roundA; j <= n; j++) {
    const logTerm = logChoose(n, j) + j * Math.log(x) + (n - j) * Math.log(1 - x)
    sum += Math.exp(logTerm)
  }
  return sum
}

/**
 * Computes the inverse CDF (quantile function) of the Beta distribution.
 * Uses bisection search over the regularized incomplete beta function.
 */
export function betaQuantile(p: number, a: number, b: number, tolerance = 1e-6): number {
  if (p <= 0) return 0
  if (p >= 1) return 1

  let low = 0
  let high = 1
  let mid = 0.5

  for (let iter = 0; iter < 50; iter++) {
    mid = (low + high) / 2
    const val = betaInc(mid, a, b)
    if (val < p) {
      low = mid
    } else {
      high = mid
    }
    if (high - low < tolerance) {
      break
    }
  }
  return mid
}

/**
 * Computes the credible interval bounds (e.g. 95%) of the Beta distribution.
 */
export function credibleInterval(params: BetaParams, level = 0.95): [number, number] {
  const alpha = Math.round(params.alpha)
  const beta = Math.round(params.beta)
  const tail = (1 - level) / 2
  const lower = betaQuantile(tail, alpha, beta)
  const upper = betaQuantile(1 - tail, alpha, beta)
  return [lower, upper]
}

/**
 * Computes the width of the credible interval for a Beta distribution.
 */
export function intervalWidth(params: BetaParams, level = 0.95): number {
  const [lower, upper] = credibleInterval(params, level)
  return upper - lower
}
