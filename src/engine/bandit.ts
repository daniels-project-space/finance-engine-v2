// Thompson-sampling bandit over mutation "recipes" (mutator op keys, lanes).
// Pure + deterministic given a seeded RNG, so a cycle is reproducible. The
// arms come from the Convex knowledge ledger (mechanismStats rows); an empty
// arm set is the cold-start signal and the caller falls back to uniform.
//
// Each arm carries Beta(alpha, beta) success/failure pseudo-counts plus a
// `suppression` scalar (derived from the failure memory / penalty graveyard)
// that inflates the failure parameter — a dead-end recipe's odds collapse
// toward zero without ever being zeroed (epsilon still revives it).

export interface Arm {
  key: string;
  alpha: number;       // 1 + successes
  beta: number;        // 1 + failures
  suppression?: number; // >=0; added onto beta to down-weight dead ends
}

/** Marsaglia–Tsang gamma sampler (shape a >= 0), via a provided uniform RNG. */
function sampleGamma(a: number, rng: () => number): number {
  if (a < 1) {
    // boost: Gamma(a) = Gamma(a+1) * U^(1/a)
    const u = Math.max(rng(), 1e-12);
    return sampleGamma(1 + a, rng) * Math.pow(u, 1 / a);
  }
  const d = a - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 256; i++) {
    let x = 0, v = 0;
    do {
      // Box–Muller normal from two uniforms
      const u1 = Math.max(rng(), 1e-12);
      const u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d; // fallback (extremely rare)
}

/** Draw from Beta(a, b) using two Gamma draws. */
export function sampleBeta(a: number, b: number, rng: () => number): number {
  const x = sampleGamma(Math.max(a, 1e-6), rng);
  const y = sampleGamma(Math.max(b, 1e-6), rng);
  const s = x + y;
  return s > 0 ? x / s : 0.5;
}

/** Posterior mean of an arm's success rate (for surprise baselines / logs). */
export function armMean(arm: Arm): number {
  const a = arm.alpha;
  const b = arm.beta + (arm.suppression ?? 0);
  return a / Math.max(a + b, 1e-9);
}

/**
 * Pick a recipe key by Thompson sampling. With probability `epsilon`, explore
 * uniformly at random (wild mutations still fire). Empty arms -> "" so the
 * caller falls back to the legacy uniform ladder (cold-start safe).
 */
export function thompsonPick(arms: Arm[], rng: () => number, epsilon: number): { key: string; wild: boolean } {
  if (!arms.length) return { key: "", wild: false };
  if (rng() < epsilon) {
    return { key: arms[Math.floor(rng() * arms.length)].key, wild: true };
  }
  let best = arms[0].key, bestScore = -1;
  for (const a of arms) {
    const score = sampleBeta(a.alpha, a.beta + (a.suppression ?? 0), rng);
    if (score > bestScore) { bestScore = score; best = a.key; }
  }
  return { key: best, wild: false };
}

/** The lowest-posterior-mean arm — the deliberate anti-Thompson "wild" pick. */
export function antiThompsonPick(arms: Arm[]): string {
  if (!arms.length) return "";
  let worst = arms[0].key, worstMean = Infinity;
  for (const a of arms) {
    const m = armMean(a);
    if (m < worstMean) { worstMean = m; worst = a.key; }
  }
  return worst;
}
