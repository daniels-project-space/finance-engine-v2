// "Validation-honesty" statistics computed in SHADOW MODE alongside the
// gauntlet. NONE of these are bound as pass/fail gates here — callers log a
// would-fail flag only. Thresholds are deferred to config so they can be made
// binding later.
//
//   Feature 1: purge+embargo helper + CSCV-based PBO (Bailey & López de Prado,
//              "The Probability of Backtest Overfitting", 2014).
//   Feature 2: parameter-stability / plateau score around the tuned params.
//   Feature 3: White's Reality Check / Hansen's SPA over a SET of candidates'
//              OOS return streams (family-wise error control).

import { runBacktest } from "./backtest";
import { mulberry32 } from "./stats";
import type { BacktestOpts, Bars, StrategyDoc } from "./types";

// ============================================================ logit / helpers
export function logit(x: number): number {
  const e = Math.min(1 - 1e-9, Math.max(1e-9, x));
  return Math.log(e / (1 - e));
}

function annSharpe(ret: ArrayLike<number>, from: number, to: number, ppy: number): number {
  const n = to - from + 1;
  if (n < 2) return 0;
  let s = 0, sq = 0;
  for (let i = from; i <= to; i++) { const r = ret[i]; s += r; sq += r * r; }
  const mean = s / n;
  const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
  return sd > 1e-12 ? (mean / sd) * Math.sqrt(ppy) : 0;
}

// ============================================================ Feature 1: purge
export interface PurgeSpan { start: number; end: number } // inclusive index range of a test fold

/**
 * Given a test fold [testStart, testEnd] (inclusive bar indices), a per-sample
 * dependency window `window` (lookback/label horizon in bars) and an embargo
 * `embargo` (bars), return a predicate: is training index `j` ALLOWED?
 *
 * Leakage rule (López de Prado, "Advances in Financial ML" ch.7):
 *   - PURGE: drop train samples whose dependency window overlaps the test fold,
 *     i.e. any j in [testStart - window, testEnd].
 *   - EMBARGO: additionally drop a band AFTER the test fold,
 *     i.e. any j in (testEnd, testEnd + embargo].
 * Combined forbidden zone: [testStart - window, testEnd + embargo].
 */
export function purgedTrainAllowed(testStart: number, testEnd: number, window: number, embargo: number): (j: number) => boolean {
  const lo = testStart - window;
  const hi = testEnd + embargo;
  return (j: number) => j < lo || j > hi;
}

/** Convenience: list the kept training indices from a candidate index pool. */
export function applyPurgeEmbargo(
  trainPool: number[], testStart: number, testEnd: number, window: number, embargo: number,
): number[] {
  const ok = purgedTrainAllowed(testStart, testEnd, window, embargo);
  return trainPool.filter(ok);
}

/** Suggested embargo = max(indicator lookback, 1% of total bars). */
export function suggestEmbargo(totalBars: number, indicatorLookback: number): number {
  return Math.max(indicatorLookback, Math.ceil(0.01 * totalBars));
}

// ============================================================ Feature 1: PBO (CSCV)
//
// Generic CSCV over a performance MATRIX M[c][b] = performance of configuration
// c on block b (N contiguous blocks). For every way of splitting the N blocks
// into an IS half and an OOS half (C(N, N/2) combinations, capped), pick the
// config with the best IS mean performance, then record its OOS rank ω∈(0,1)
// among all configs on the OOS half. λ = logit(ω). PBO = fraction of splits
// with λ ≤ 0 (i.e. the IS-best config landed in the bottom OOS half).

export interface PboResult {
  pbo: number;
  nSplits: number;
  nConfigs: number;
  nBlocks: number;
  medianLogit: number;
  /** would-fail in shadow mode if pbo >= warnAt (default 0.5) */
  proxy: boolean; // true if a single-strategy proxy matrix was used
  note?: string;
}

/** all combinations of choosing k of [0..n-1], capped at `cap` (deterministic sampling if exceeded). */
function combinations(n: number, k: number, cap: number, rng: () => number): number[][] {
  const out: number[][] = [];
  const full: number[] = [];
  const rec = (start: number, pick: number[]) => {
    if (out.length >= cap) return;
    if (pick.length === k) { out.push(pick.slice()); return; }
    for (let i = start; i <= n - (k - pick.length); i++) {
      pick.push(i); rec(i + 1, pick); pick.pop();
      if (out.length >= cap) return;
    }
  };
  // exact enumeration when small enough, else random sampling of distinct subsets
  const exactCount = binom(n, k);
  if (exactCount <= cap) { rec(0, full); return out; }
  const seen = new Set<string>();
  while (out.length < cap && seen.size < exactCount) {
    const idx = new Set<number>();
    while (idx.size < k) idx.add(Math.floor(rng() * n));
    const arr = Array.from(idx).sort((a, b) => a - b);
    const key = arr.join(",");
    if (!seen.has(key)) { seen.add(key); out.push(arr); }
  }
  return out;
}

function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

/**
 * CSCV PBO from a performance matrix M[config][block].
 * Higher performance = better. Returns PBO and diagnostics.
 */
export function pboFromMatrix(M: number[][], opts: { capSplits?: number; seed?: number; proxy?: boolean } = {}): PboResult {
  const nConfigs = M.length;
  const nBlocks = nConfigs ? M[0].length : 0;
  const note: string[] = [];
  if (nConfigs < 2 || nBlocks < 4) {
    return { pbo: 0, nSplits: 0, nConfigs, nBlocks, medianLogit: 0, proxy: !!opts.proxy, note: "insufficient configs/blocks for CSCV" };
  }
  // CSCV requires an even number of blocks; drop the last block if odd.
  let N = nBlocks;
  if (N % 2 === 1) { N -= 1; note.push(`dropped 1 block to make N even (N=${N})`); }
  const half = N / 2;
  const rng = mulberry32(opts.seed ?? 20260614);
  const cap = opts.capSplits ?? 1000;
  const isCombos = combinations(N, half, cap, rng);

  const lambdas: number[] = [];
  let nLambdaLEzero = 0;
  for (const isBlocks of isCombos) {
    const isSet = new Set(isBlocks);
    const oosBlocks: number[] = [];
    for (let b = 0; b < N; b++) if (!isSet.has(b)) oosBlocks.push(b);

    // IS mean performance per config -> pick best
    let bestC = 0, bestIS = -Infinity;
    for (let c = 0; c < nConfigs; c++) {
      let s = 0;
      for (const b of isBlocks) s += M[c][b];
      const m = s / isBlocks.length;
      if (m > bestIS) { bestIS = m; bestC = c; }
    }
    // OOS performance per config; rank of the IS-best
    const oosPerf = new Array(nConfigs);
    for (let c = 0; c < nConfigs; c++) {
      let s = 0;
      for (const b of oosBlocks) s += M[c][b];
      oosPerf[c] = s / oosBlocks.length;
    }
    const bestVal = oosPerf[bestC];
    // rank: number of configs with strictly-better OOS perf, ties share rank.
    let better = 0, equal = 0;
    for (let c = 0; c < nConfigs; c++) {
      if (oosPerf[c] > bestVal) better++;
      else if (oosPerf[c] === bestVal) equal++;
    }
    // relative rank ω in (0,1): fraction of configs the IS-best beat (mid-rank for ties)
    const rankPos = better + (equal - 1) / 2;     // 0 = best OOS, nConfigs-1 = worst
    const omega = 1 - rankPos / (nConfigs - 1);    // 1 = best, 0 = worst (OOS performance percentile)
    const lam = logit(omega);
    lambdas.push(lam);
    if (lam <= 0) nLambdaLEzero++;                 // landed in the bottom OOS half => overfit
  }
  lambdas.sort((a, b) => a - b);
  const median = lambdas.length ? lambdas[Math.floor(lambdas.length / 2)] : 0;
  return {
    pbo: lambdas.length ? nLambdaLEzero / lambdas.length : 0,
    nSplits: lambdas.length,
    nConfigs, nBlocks: N,
    medianLogit: median,
    proxy: !!opts.proxy,
    note: note.length ? note.join("; ") : undefined,
  };
}

/**
 * Build the CSCV performance matrix for a real strategy by evaluating each tuned
 * configuration across N contiguous blocks of the bar range, then run PBO.
 *
 * `configs` are the parameter sets the tuner actually tried. When the real
 * config set is unavailable, callers should pass a labelled single-strategy
 * proxy (e.g. perturbations of the final params) and set proxy:true.
 *
 * Performance metric per block = annualized Sharpe of per-bar returns in that
 * block (warm-started from the range start so indicators are valid).
 */
export function computePbo(
  doc: StrategyDoc,
  bars: Bars,
  opts: BacktestOpts,
  configs: Record<string, number>[],
  range: { startI: number; endI: number },
  cfg: { nBlocks?: number; capSplits?: number; seed?: number; proxy?: boolean } = {},
): PboResult {
  const nBlocks = Math.max(4, Math.min(14, cfg.nBlocks ?? 10));
  const start = range.startI, end = range.endI;
  const span = end - start + 1;
  if (configs.length < 2 || span < nBlocks * 20) {
    return { pbo: 0, nSplits: 0, nConfigs: configs.length, nBlocks, medianLogit: 0, proxy: !!cfg.proxy, note: "insufficient data/configs" };
  }
  const blockLen = Math.floor(span / nBlocks);
  // precompute block boundaries (contiguous, last block absorbs remainder)
  const bounds: { s: number; e: number }[] = [];
  for (let b = 0; b < nBlocks; b++) {
    const s = start + b * blockLen;
    const e = b === nBlocks - 1 ? end : s + blockLen - 1;
    bounds.push({ s, e });
  }
  // M[config][block] = block annualized Sharpe
  const M: number[][] = [];
  for (const params of configs) {
    const res = runBacktest(doc, bars, params, opts, { startI: start, endI: end });
    const row: number[] = [];
    for (const { s, e } of bounds) row.push(annSharpe(res.ret, s, e, opts.ppy));
    M.push(row);
  }
  return pboFromMatrix(M, { capSplits: cfg.capSplits, seed: cfg.seed, proxy: cfg.proxy });
}

// ============================================================ Feature 2: stability
export interface StabilityResult {
  stability: number;        // [0,1]
  baseSharpe: number;
  neighborFrac: number;     // fraction of neighbors >= 0.7*baseSharpe
  smoothness: number;       // 1 - normalized std of neighbor sharpes
  nNeighbors: number;
}

/**
 * Parameter-stability / plateau score around `finalParams`.
 * Perturb each numeric param by ±10% and ±20% (grid), recompute full-period
 * Sharpe per neighbor. stability = neighborFrac combined with a smoothness term
 * (1 - normStd of neighbor sharpes), clamped to [0,1].
 *
 * A flat objective (Sharpe ~constant in params) -> stability ~1.
 * A knife-edge objective (Sharpe collapses off the peak) -> stability ~0.
 */
export function paramStability(
  doc: StrategyDoc,
  bars: Bars,
  opts: BacktestOpts,
  finalParams: Record<string, number>,
  range: { startI: number; endI: number },
  cfg: { deltas?: number[]; goodFrac?: number; sharpeFn?: (p: Record<string, number>) => number } = {},
): StabilityResult {
  const deltas = cfg.deltas ?? [-0.2, -0.1, 0.1, 0.2];
  const goodFrac = cfg.goodFrac ?? 0.7;
  // injectable objective (tests drive a known surface); defaults to the real backtest
  const sharpeAt = cfg.sharpeFn ?? ((p: Record<string, number>) =>
    runBacktest(doc, bars, p, opts, { startI: range.startI, endI: range.endI }).metrics.sharpe);

  const baseSharpe = sharpeAt(finalParams);
  const keys = Object.keys(doc.params ?? {}).filter((k) => Number.isFinite(finalParams[k]));
  if (!keys.length) {
    // no tunable params: trivially stable (nothing to perturb)
    return { stability: 1, baseSharpe, neighborFrac: 1, smoothness: 1, nNeighbors: 0 };
  }

  const neighborSharpes: number[] = [];
  for (const k of keys) {
    const spec = doc.params[k];
    for (const d of deltas) {
      const p = { ...finalParams };
      let v = finalParams[k] * (1 + d);
      v = Math.min(spec.max, Math.max(spec.min, v));
      if (spec.int) v = Math.round(v);
      if (v === finalParams[k]) continue; // perturbation clipped to a no-op
      p[k] = v;
      neighborSharpes.push(sharpeAt(p));
    }
  }
  if (!neighborSharpes.length) return { stability: 1, baseSharpe, neighborFrac: 1, smoothness: 1, nNeighbors: 0 };

  const threshold = goodFrac * baseSharpe;
  // when base is non-positive the "fraction above 0.7*base" test is ill-posed;
  // fall back to "neighbor >= base - small" so a flat-zero objective stays stable.
  const passCount = neighborSharpes.filter((s) =>
    baseSharpe > 1e-9 ? s >= threshold : s >= baseSharpe - 0.1
  ).length;
  const neighborFrac = passCount / neighborSharpes.length;

  // smoothness: 1 - RMS deviation of neighbors FROM THE BASE, normalized. This
  // penalizes BOTH spread (jagged surface) AND a uniform collapse off the peak
  // (a knife-edge whose neighbors all drop to ~0 has low internal spread but a
  // large drop from base, so it is correctly judged unstable).
  let sse = 0;
  for (const s of neighborSharpes) sse += (s - baseSharpe) * (s - baseSharpe);
  const rmsDev = Math.sqrt(sse / neighborSharpes.length);
  const scale = Math.max(0.25, Math.abs(baseSharpe)); // avoid blow-up near zero base
  const smoothness = Math.max(0, Math.min(1, 1 - rmsDev / scale));

  const stability = Math.max(0, Math.min(1, 0.6 * neighborFrac + 0.4 * smoothness));
  return { stability, baseSharpe, neighborFrac, smoothness, nNeighbors: neighborSharpes.length };
}

// ============================================================ Feature 3: Reality Check / SPA
export interface RealityCheckResult {
  /** family-wise p-value for the BEST candidate (White's Reality Check) */
  bestRcP: number;
  /** Hansen SPA consistent p-value for the best candidate */
  bestSpaP: number;
  /** per-candidate family-wise p (RC): P(max_null >= this candidate's studentized stat) */
  perCandidateP: number[];
  bestIndex: number;
  bestStat: number;
  nReps: number;
  nCandidates: number;
}

/**
 * White's Reality Check + Hansen's SPA over a SET of candidates' OOS return
 * series. The null is "no candidate has positive expected excess return".
 * Studentized statistic per candidate: sqrt(n) * mean(ret) / sd(ret).
 * Stationary bootstrap (Politis & Romano) recentred to the mean-zero null gives
 * the distribution of max-over-candidates; the best candidate's family-wise p =
 * P(max_null >= observed best stat).
 *
 * Streams need not be equal length or aligned; each is bootstrapped on its own
 * index set with a shared mean block length.
 */
export function realityCheck(
  returnsByCandidate: number[][],
  cfg: { nReps?: number; meanBlock?: number; seed?: number } = {},
): RealityCheckResult {
  const k = returnsByCandidate.length;
  const nReps = cfg.nReps ?? 1000;
  const meanBlock = cfg.meanBlock ?? 20;
  const rng = mulberry32(cfg.seed ?? 9176);
  const empty: RealityCheckResult = { bestRcP: 1, bestSpaP: 1, perCandidateP: new Array(k).fill(1), bestIndex: -1, bestStat: 0, nReps, nCandidates: k };
  if (k === 0) return empty;

  // observed studentized statistic per candidate
  const stats = new Array<number>(k);
  const means = new Array<number>(k);
  const sds = new Array<number>(k);
  const ns = new Array<number>(k);
  for (let c = 0; c < k; c++) {
    const r = returnsByCandidate[c];
    const n = r.length;
    ns[c] = n;
    if (n < 5) { stats[c] = -Infinity; means[c] = 0; sds[c] = 1; continue; }
    let s = 0, sq = 0;
    for (const x of r) { s += x; sq += x * x; }
    const mean = s / n;
    const sd = Math.sqrt(Math.max(1e-18, sq / n - mean * mean));
    means[c] = mean; sds[c] = sd;
    stats[c] = Math.sqrt(n) * mean / sd;
  }
  let bestIndex = 0;
  for (let c = 1; c < k; c++) if (stats[c] > stats[bestIndex]) bestIndex = c;
  const bestStat = stats[bestIndex];

  // stationary bootstrap: geometric block length, prob p = 1/meanBlock of a new start.
  const p = 1 / Math.max(2, meanBlock);
  // per-candidate count of bootstrap reps whose recentred stat >= its OBSERVED stat
  const geMaxObserved = new Array<number>(k).fill(0);  // for RC per-candidate p (vs that candidate)
  let rcMaxGE = 0;   // reps where max_c V*_c >= bestStat  (White RC for the best)
  let spaMaxGE = 0;  // Hansen SPA (consistent recentring)

  // SPA recentring threshold per candidate: only candidates not "too bad" contribute.
  // g_c = mean_c, A_c = sd_c/sqrt(n); include if mean_c >= -A_c*sqrt(2 log log n)
  const include = new Array<boolean>(k);
  for (let c = 0; c < k; c++) {
    const n = ns[c];
    const Ac = sds[c] / Math.sqrt(Math.max(1, n));
    const thr = -Ac * Math.sqrt(2 * Math.log(Math.max(3, Math.log(Math.max(3, n)))));
    include[c] = Number.isFinite(stats[c]) && means[c] >= thr;
  }

  for (let rep = 0; rep < nReps; rep++) {
    let maxV_rc = -Infinity;   // White RC: recenter ALL candidates by their full mean
    let maxV_spa = -Infinity;  // Hansen SPA: recenter only "included" candidates
    for (let c = 0; c < k; c++) {
      const r = returnsByCandidate[c];
      const n = r.length;
      if (n < 5) continue;
      // resample n observations via stationary bootstrap
      let s = 0, sq = 0;
      let idx = Math.floor(rng() * n);
      for (let i = 0; i < n; i++) {
        const x = r[idx];
        s += x; sq += x * x;
        if (rng() < p) idx = Math.floor(rng() * n);
        else idx = (idx + 1) % n;
      }
      const bMean = s / n;
      const bSd = Math.sqrt(Math.max(1e-18, sq / n - bMean * bMean));
      // recentred studentized stat under H0: subtract the observed mean
      const vRC = Math.sqrt(n) * (bMean - means[c]) / bSd;
      const vc = vRC;
      // per-candidate RC: does the recentred stat exceed THIS candidate's observed stat?
      if (vc >= stats[c]) geMaxObserved[c]++;       // (vs-self => valid single p, conservative family handled via max below)
      if (vc > maxV_rc) maxV_rc = vc;
      if (include[c] && vc > maxV_spa) maxV_spa = vc;
    }
    if (maxV_rc >= bestStat) rcMaxGE++;
    if (maxV_spa >= bestStat) spaMaxGE++;
  }

  // per-candidate FAMILY-WISE p: P(max_null >= candidate's observed stat).
  // Recompute the max-null exceedance per candidate threshold in a second cheap
  // pass would double cost; instead approximate with the SAME max distribution:
  // a candidate's family-wise p = fraction of reps where maxV_rc >= its stat.
  // We accumulate that here by re-deriving from stored bestStat ordering is not
  // possible, so do a dedicated light pass:
  const perCandidateP = familywisePerCandidate(returnsByCandidate, means, sds, ns, stats, { nReps: Math.min(nReps, 600), meanBlock, seed: (cfg.seed ?? 9176) ^ 0x5bd1e995 });

  return {
    bestRcP: (rcMaxGE + 1) / (nReps + 1),
    bestSpaP: (spaMaxGE + 1) / (nReps + 1),
    perCandidateP,
    bestIndex,
    bestStat,
    nReps,
    nCandidates: k,
  };
}

/** Family-wise per-candidate p via the max-statistic null distribution. */
function familywisePerCandidate(
  returnsByCandidate: number[][],
  means: number[], sds: number[], ns: number[], stats: number[],
  cfg: { nReps: number; meanBlock: number; seed: number },
): number[] {
  const k = returnsByCandidate.length;
  const rng = mulberry32(cfg.seed);
  const p = 1 / Math.max(2, cfg.meanBlock);
  const maxNull: number[] = [];
  for (let rep = 0; rep < cfg.nReps; rep++) {
    let maxV = -Infinity;
    for (let c = 0; c < k; c++) {
      const r = returnsByCandidate[c];
      const n = r.length;
      if (n < 5) continue;
      let s = 0, sq = 0;
      let idx = Math.floor(rng() * n);
      for (let i = 0; i < n; i++) {
        const x = r[idx];
        s += x; sq += x * x;
        if (rng() < p) idx = Math.floor(rng() * n);
        else idx = (idx + 1) % n;
      }
      const bMean = s / n;
      const bSd = Math.sqrt(Math.max(1e-18, sq / n - bMean * bMean));
      const v = Math.sqrt(n) * (bMean - means[c]) / bSd;
      if (v > maxV) maxV = v;
    }
    maxNull.push(maxV);
  }
  maxNull.sort((a, b) => a - b);
  // p_c = fraction of maxNull >= stats[c]
  return stats.map((st) => {
    if (!Number.isFinite(st)) return 1;
    // count maxNull >= st
    let lo = 0, hi = maxNull.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (maxNull[mid] < st) lo = mid + 1; else hi = mid; }
    const ge = maxNull.length - lo;
    return (ge + 1) / (maxNull.length + 1);
  });
}
