// Deterministic random-search tuner. Tuning ONLY ever sees the slice of data
// it is given — walk-forward and seal discipline live in the callers.

import { createRequire } from "node:module";
import { runBacktest, indexOfTs } from "./backtest";
import { mulberry32 } from "./stats";
import type { BacktestOpts, Bars, StrategyDoc } from "./types";

const _require = createRequire(import.meta.url);

export interface TuneResult {
  params: Record<string, number>;
  objective: number;
  sharpe: number;
  trades: number;
}

/** objective = sharpe shrunk toward 0 for low trade counts (k=20 trades half-weight) */
export function objective(sharpe: number, trades: number): number {
  const shrink = trades / (trades + 20);
  return sharpe * shrink;
}

// ---- MULTI-SYMBOL TUNING (cross-symbol-robust param selection) -------------
// ROOT FIX (2026-06-23): param selection used to optimize a single symbol's
// Sharpe (BTC-primary), so every fit was BTC-overfit by construction and only
// met the other perps at S4 — too late to steer. A `cosymbols` set makes the
// tuning OBJECTIVE see the other perps DURING selection: each config is scored
// on the primary AND every co-symbol over the SAME calendar window, then combined
// into a robust cross-symbol score. Params that only work on BTC now score worse
// and lose. This does NOT change any pass/fail floor — only the objective that
// SELECTS params. Omit `cosymbols` => exact legacy single-symbol behaviour.
export interface CoSymbol { bars: Bars; opts: BacktestOpts }

// Robust cross-symbol combiner, aligned with the S4 kill: candidates die on the
// CROSS-SYMBOL count (WF-positive on too few perps), not on pooled Sharpe — which
// one strong symbol can dominate. The MEDIAN per-symbol objective penalises
// single-symbol fits directly (great on BTC, flat on 4 others => low median). We
// blend 0.6*median + 0.4*mean so the surface stays smooth enough for the
// hill-climb / TPE to have gradient (pure median is piecewise-flat). A symbol that
// barely trades contributes its (trade-shrunk, ~0) objective, correctly dragging
// the score down.
export function multiSymbolObjective(perSymbolObjectives: number[]): number {
  const v = perSymbolObjectives.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return -1e9;
  const n = v.length;
  const median = n % 2 ? v[(n - 1) / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
  const mean = v.reduce((a, b) => a + b, 0) / n;
  return 0.6 * median + 0.4 * mean;
}

/** Map a primary-bars index range to the matching calendar window on a co-symbol
 *  (different symbols have different index<->timestamp maps). Returns null when
 *  the co-symbol lacks enough bars in that window to tune on. */
function coRange(primaryT: ArrayLike<number>, range: { startI: number; endI: number }, co: Bars): { startI: number; endI: number } | null {
  const startTs = primaryT[range.startI];
  const endTs = primaryT[range.endI];
  const co_t = co.t as unknown as number[];
  const s = Math.max(1, indexOfTs(co_t, startTs));
  let e = indexOfTs(co_t, endTs);
  if (e >= co.t.length) e = co.t.length - 1;
  if (e - s < 50) return null; // not enough overlapping data to be meaningful
  return { startI: s, endI: e };
}

/**
 * Build the objective evaluator used by BOTH tuners. With no `cosymbols` it is
 * the exact legacy single-symbol objective. With `cosymbols`, the returned
 * objective is the robust cross-symbol combiner over {primary, ...cosymbols},
 * while `sharpe`/`trades` continue to report the PRIMARY symbol (so callers and
 * the S2-train screen keep their single-symbol semantics; only the SELECTION
 * objective changes). Each config is evaluated on the same calendar window per
 * symbol via timestamp mapping.
 */
export function makeEvaluate(
  doc: StrategyDoc,
  bars: Bars,
  opts: BacktestOpts,
  range: { startI: number; endI: number },
  cosymbols?: CoSymbol[],
): (params: Record<string, number>) => { objective: number; sharpe: number; trades: number } {
  if (!cosymbols || cosymbols.length === 0) {
    return (params) => {
      const res = runBacktest(doc, bars, params, opts, range);
      return { objective: objective(res.metrics.sharpe, res.metrics.trades), sharpe: res.metrics.sharpe, trades: res.metrics.trades };
    };
  }
  // pre-resolve each co-symbol's calendar window once (constant across configs)
  const coRanges = cosymbols
    .map((c) => ({ c, r: coRange(bars.t, range, c.bars) }))
    .filter((x): x is { c: CoSymbol; r: { startI: number; endI: number } } => x.r !== null);
  return (params) => {
    const primaryRes = runBacktest(doc, bars, params, opts, range);
    const primObj = objective(primaryRes.metrics.sharpe, primaryRes.metrics.trades);
    const perSym = [primObj];
    for (const { c, r } of coRanges) {
      const res = runBacktest(doc, c.bars, params, c.opts, r);
      perSym.push(objective(res.metrics.sharpe, res.metrics.trades));
    }
    return {
      objective: multiSymbolObjective(perSym),
      sharpe: primaryRes.metrics.sharpe,   // primary-symbol Sharpe (S2 screen semantics)
      trades: primaryRes.metrics.trades,
    };
  };
}

// ---- WAVE-3b: optional Bayesian (TPE) tuner, DEFAULT OFF -------------------
// When `bayesTuning` is enabled the pipeline calls setBayesTuning(true, cfg)
// once per process; tune()/tuneWithConfigs() then delegate to bayesOptimize
// (interface-compatible, still returns every evaluated config for the PBO probe).
// Default is FALSE: the legacy adaptive random-search + hill-climb below runs
// UNCHANGED. The bayesopt import is lazy (require) so there is no static import
// cycle (bayesopt imports `objective`/`TuneResult` from here).
let BAYES_ON = false;
let BAYES_CFG: unknown = undefined;
export function setBayesTuning(on: boolean, cfg?: unknown): void { BAYES_ON = on; BAYES_CFG = cfg; }
export function bayesTuningEnabled(): boolean { return BAYES_ON; }

function delegateBayes(
  doc: StrategyDoc, bars: Bars, opts: BacktestOpts, range: { startI: number; endI: number }, nTrials: number, seed: number,
  cosymbols?: CoSymbol[],
): (TuneResult & { configs: { params: Record<string, number>; objective: number; sharpe: number }[] }) | null {
  if (!BAYES_ON) return null;
  // lazy require to avoid a static import cycle with ./bayesopt
  const { bayesTune } = _require("./bayesopt") as typeof import("./bayesopt");
  return bayesTune(doc, bars, opts, range, nTrials, seed, BAYES_CFG as Parameters<typeof bayesTune>[6], cosymbols);
}

export function sampleParams(doc: StrategyDoc, rng: () => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries(doc.params ?? {})) {
    let v = p.min + (p.max - p.min) * rng();
    if (p.int) v = Math.round(v);
    out[k] = v;
  }
  return out;
}

/** scale the search budget with dimensionality */
export function adaptiveTrials(doc: StrategyDoc, base = 40): number {
  return Math.min(200, base + 30 * Object.keys(doc.params ?? {}).length);
}

export function tune(
  doc: StrategyDoc,
  bars: Bars,
  opts: BacktestOpts,
  range: { startI: number; endI: number },
  nTrials = 60,
  seed = 11,
  cosymbols?: CoSymbol[],
): TuneResult {
  // WAVE-3b: delegate to the Bayesian tuner when enabled (default off).
  const bayes = delegateBayes(doc, bars, opts, range, nTrials, seed, cosymbols);
  if (bayes) { const { configs, ...r } = bayes; void configs; return r; }
  const rng = mulberry32(seed);
  const specs = doc.params ?? {};
  const hasParams = Object.keys(specs).length > 0;
  let best: TuneResult | null = null;
  const evaluate = makeEvaluate(doc, bars, opts, range, cosymbols);
  const evalOne = (params: Record<string, number>): TuneResult => {
    const r = evaluate(params);
    return { params, objective: r.objective, sharpe: r.sharpe, trades: r.trades };
  };
  const trials = hasParams ? nTrials : 1;
  for (let t = 0; t < trials; t++) {
    const params = t === 0
      ? Object.fromEntries(Object.entries(specs).map(([k, p]) => [k, p.default]))
      : sampleParams(doc, rng);
    const r = evalOne(params);
    if (!best || r.objective > best.objective) best = r;
  }
  // phase 2: hill-climb refinement around the random-search winner (still
  // strictly inside the given range — no extra data is seen)
  if (hasParams && best && best.objective > 0) {
    const refine = Math.min(16, Math.ceil(trials / 4));
    for (let t = 0; t < refine; t++) {
      const params: Record<string, number> = {};
      for (const [k, p] of Object.entries(specs)) {
        let v = (best.params[k] ?? p.default) * (1 + (rng() * 2 - 1) * 0.12);
        v = Math.min(p.max, Math.max(p.min, v));
        if (p.int) v = Math.round(v);
        params[k] = v;
      }
      const r = evalOne(params);
      if (r.objective > best.objective) best = r;
    }
  }
  return best as TuneResult;
}

/**
 * Like tune(), but also returns EVERY configuration evaluated (random-search +
 * hill-climb refinement) with its objective. Used by the CSCV/PBO shadow metric
 * so the overfitting probe sees the real tuning configuration set, not a proxy.
 */
export function tuneWithConfigs(
  doc: StrategyDoc,
  bars: Bars,
  opts: BacktestOpts,
  range: { startI: number; endI: number },
  nTrials = 60,
  seed = 11,
  cosymbols?: CoSymbol[],
): TuneResult & { configs: { params: Record<string, number>; objective: number; sharpe: number }[] } {
  // WAVE-3b: delegate to the Bayesian tuner when enabled (default off). It
  // returns the same {..., configs} shape so the PBO probe is unaffected.
  const bayes = delegateBayes(doc, bars, opts, range, nTrials, seed, cosymbols);
  if (bayes) return bayes;
  const rng = mulberry32(seed);
  const specs = doc.params ?? {};
  const hasParams = Object.keys(specs).length > 0;
  const configs: { params: Record<string, number>; objective: number; sharpe: number }[] = [];
  let best: TuneResult | null = null;
  const evaluate = makeEvaluate(doc, bars, opts, range, cosymbols);
  const evalOne = (params: Record<string, number>): TuneResult => {
    const r0 = evaluate(params);
    const r = { params, objective: r0.objective, sharpe: r0.sharpe, trades: r0.trades };
    configs.push({ params: { ...params }, objective: r.objective, sharpe: r.sharpe });
    return r;
  };
  const trials = hasParams ? nTrials : 1;
  for (let t = 0; t < trials; t++) {
    const params = t === 0
      ? Object.fromEntries(Object.entries(specs).map(([k, p]) => [k, p.default]))
      : sampleParams(doc, rng);
    const r = evalOne(params);
    if (!best || r.objective > best.objective) best = r;
  }
  if (hasParams && best && best.objective > 0) {
    const refine = Math.min(16, Math.ceil(trials / 4));
    for (let t = 0; t < refine; t++) {
      const params: Record<string, number> = {};
      for (const [k, p] of Object.entries(specs)) {
        let v = (best.params[k] ?? p.default) * (1 + (rng() * 2 - 1) * 0.12);
        v = Math.min(p.max, Math.max(p.min, v));
        if (p.int) v = Math.round(v);
        params[k] = v;
      }
      const r = evalOne(params);
      if (r.objective > best.objective) best = r;
    }
  }
  return { ...(best as TuneResult), configs };
}
