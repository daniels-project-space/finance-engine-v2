// Statistical validation: Deflated Sharpe Ratio (Bailey & López de Prado),
// market-return permutation test (Masters/Aronson), block-bootstrap Sharpe CI.

import { runBacktest } from "./backtest";
import type { BacktestOpts, Bars, StrategyDoc } from "./types";

// ---------- normal distribution helpers ----------
export function normCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  if (x > 0) p = 1 - p;
  return p;
}

export function normInv(p: number): number {
  // Acklam's algorithm
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425, phigh = 1 - plow;
  let q: number, r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---------- moments ----------
function moments(r: Float64Array, from: number, to: number) {
  const n = to - from + 1;
  let s = 0;
  for (let i = from; i <= to; i++) s += r[i];
  const mean = s / n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (let i = from; i <= to; i++) {
    const d = r[i] - mean;
    m2 += d * d; m3 += d * d * d; m4 += d * d * d * d;
  }
  m2 /= n; m3 /= n; m4 /= n;
  const sd = Math.sqrt(m2);
  return { n, mean, sd, skew: sd > 0 ? m3 / (sd ** 3) : 0, kurt: sd > 0 ? m4 / (sd ** 4) : 3 };
}

/**
 * Probabilistic Sharpe Ratio: P(true SR > srBenchmark), using per-period SR
 * with skew/kurtosis correction. Bailey & López de Prado (2012).
 */
export function psr(ret: Float64Array, from: number, to: number, srBenchmarkPerPeriod: number): number {
  const { n, mean, sd, skew, kurt } = moments(ret, from, to);
  if (sd <= 1e-12 || n < 10) return 0;
  const sr = mean / sd;
  const denom = Math.sqrt(1 - skew * sr + ((kurt - 1) / 4) * sr * sr);
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  return normCdf(((sr - srBenchmarkPerPeriod) * Math.sqrt(n - 1)) / denom);
}

/**
 * Deflated Sharpe Ratio: PSR against the expected max SR of nTrials independent
 * trials (multiple-testing deflation). Bailey & Lopez de Prado (2014).
 *
 * UNITS FIX (2026-06-23): psr() works in PER-BAR Sharpe units (sr = mean/sd over
 * `ppy` bars/year, with the n-bar standard-error term sqrt(n-1)). The deflation
 * benchmark sr0 must therefore also be PER-BAR. The trial-Sharpe dispersion is
 * naturally quoted ANNUALIZED (a typical cross-sectional std of strategy Sharpes
 * is ~0.5/yr), so we accept `varTrialsSRAnnual` in annualized units and convert
 * to per-bar variance by dividing by ppy (sr_perbar = sr_annual / sqrt(ppy) =>
 * var_perbar = var_annual / ppy). The old code used 0.001 as if it were already
 * per-bar but it was effectively annual-scaled, so sqrt(0.001)=0.0316 dwarfed
 * every real strategy's per-bar Sharpe (annual SR 3.0 ~ 0.032/bar on 1h data) and
 * collapsed DSR to 0 for ALL candidates regardless of merit — an impassable gate.
 *
 * varTrialsSRAnnual default 0.25 (annual SR std 0.5): defensible cross-sectional
 * dispersion of trial Sharpes. Acceptance-verified curve at N=40: SR 0.5 fails,
 * SR ~1.0-1.2 borderline, SR 2.0+ passes; bar rises with nTrials. Empirical
 * per-family variance is preferred but not yet plumbed to the gate (fingerprints
 * store no Sharpe), so this conservative default stands until that data exists.
 */
export function dsr(
  ret: Float64Array,
  from: number,
  to: number,
  nTrials: number,
  ppy: number,
  varTrialsSRAnnual = 0.25,
): number {
  const EULER = 0.5772156649015329;
  const N = Math.max(2, nTrials);
  const e = Math.E;
  const varTrialsSRPerBar = varTrialsSRAnnual / Math.max(1, ppy); // annualized -> per-bar, matches psr() units
  const sr0 = Math.sqrt(varTrialsSRPerBar) * ((1 - EULER) * normInv(1 - 1 / N) + EULER * normInv(1 - 1 / (N * e)));
  return psr(ret, from, to, sr0);
}

// ---------- deterministic RNG ----------
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- permutation test ----------
/**
 * Permute the MARKET's log returns (correct null: same return distribution,
 * destroyed temporal structure), rebuild a synthetic OHLCV series, rerun the
 * strategy, and ask how often a permuted market produces an equal-or-better
 * Sharpe. p < 0.05 => the edge depends on real temporal structure.
 */
export function permutationTest(
  doc: StrategyDoc,
  bars: Bars,
  params: Record<string, number>,
  opts: BacktestOpts,
  observedSharpe: number,
  nPerms = 200,
  seed = 1337,
): { p: number; nBetter: number } {
  const n = bars.c.length;
  const logR = new Float64Array(n - 1);
  for (let i = 1; i < n; i++) logR[i - 1] = Math.log(bars.c[i] / bars.c[i - 1]);
  // relative intrabar shape (vs close): preserved per-bar, shuffled with returns
  const relO = new Float64Array(n), relH = new Float64Array(n), relL = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    relO[i] = bars.o[i] / bars.c[i]; relH[i] = bars.h[i] / bars.c[i]; relL[i] = bars.l[i] / bars.c[i];
  }
  const rng = mulberry32(seed);
  const order = new Int32Array(n - 1);
  let nBetter = 0;
  for (let p = 0; p < nPerms; p++) {
    for (let i = 0; i < n - 1; i++) order[i] = i;
    for (let i = n - 2; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const tmp = order[i]; order[i] = order[j]; order[j] = tmp; }
    const synth: Bars = { ...bars, o: new Array(n), h: new Array(n), l: new Array(n), c: new Array(n), v: bars.v };
    let px = bars.c[0];
    synth.c[0] = px; synth.o[0] = bars.o[0]; synth.h[0] = bars.h[0]; synth.l[0] = bars.l[0];
    for (let i = 1; i < n; i++) {
      const src = order[i - 1] + 1; // bar whose return+shape we borrow
      px *= Math.exp(logR[order[i - 1]]);
      synth.c[i] = px;
      synth.o[i] = px * relO[src]; synth.h[i] = px * relH[src]; synth.l[i] = px * relL[src];
    }
    const res = runBacktest(doc, synth, params, opts);
    if (res.metrics.sharpe >= observedSharpe) nBetter++;
  }
  return { p: (nBetter + 1) / (nPerms + 1), nBetter };
}

// ---------- block bootstrap CI ----------
/** Circular block bootstrap on per-bar strategy returns. Returns CI of annualized Sharpe. */
export function bootstrapSharpeCI(
  ret: Float64Array, from: number, to: number, ppy: number,
  nBoot = 1000, blockLen = 24, seed = 42,
): { lo: number; hi: number; p5: number; median: number } {
  const n = to - from + 1;
  if (n < blockLen * 3) return { lo: -9, hi: 9, p5: -9, median: 0 };
  const rng = mulberry32(seed);
  const sharpes: number[] = [];
  const nBlocks = Math.ceil(n / blockLen);
  for (let b = 0; b < nBoot; b++) {
    let s = 0, sq = 0, cnt = 0;
    for (let k = 0; k < nBlocks; k++) {
      const start = from + Math.floor(rng() * n);
      for (let j = 0; j < blockLen && cnt < n; j++) {
        const r = ret[from + ((start - from + j) % n)];
        s += r; sq += r * r; cnt++;
      }
    }
    const mean = s / cnt;
    const sd = Math.sqrt(Math.max(0, sq / cnt - mean * mean));
    sharpes.push(sd > 1e-12 ? (mean / sd) * Math.sqrt(ppy) : 0);
  }
  sharpes.sort((a, b) => a - b);
  const q = (p: number) => sharpes[Math.min(sharpes.length - 1, Math.floor(p * sharpes.length))];
  return { lo: q(0.025), hi: q(0.975), p5: q(0.05), median: q(0.5) };
}

/** MC shuffle of strategy returns: distribution of maxDD under reordering. */
export function shuffleDDPercentile(ret: Float64Array, from: number, to: number, observedMaxDD: number, nShuffles = 500, seed = 7): number {
  const n = to - from + 1;
  const rng = mulberry32(seed);
  const arr = new Float64Array(n);
  for (let i = 0; i < n; i++) arr[i] = ret[from + i];
  let worseCount = 0;
  const work = new Float64Array(n);
  for (let s = 0; s < nShuffles; s++) {
    work.set(arr);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = work[i]; work[i] = work[j]; work[j] = t; }
    let eq = 1, peak = 1, dd = 0;
    for (let i = 0; i < n; i++) { eq *= 1 + work[i]; if (eq > peak) peak = eq; const d = eq / peak - 1; if (d < dd) dd = d; }
    if (dd <= observedMaxDD) worseCount++;
  }
  return worseCount / nShuffles; // fraction of shuffles with WORSE (deeper) DD than observed
}
