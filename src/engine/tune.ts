// Deterministic random-search tuner. Tuning ONLY ever sees the slice of data
// it is given — walk-forward and seal discipline live in the callers.

import { createRequire } from "node:module";
import { runBacktest } from "./backtest";
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
): (TuneResult & { configs: { params: Record<string, number>; objective: number; sharpe: number }[] }) | null {
  if (!BAYES_ON) return null;
  // lazy require to avoid a static import cycle with ./bayesopt
  const { bayesTune } = _require("./bayesopt") as typeof import("./bayesopt");
  return bayesTune(doc, bars, opts, range, nTrials, seed, BAYES_CFG as Parameters<typeof bayesTune>[6]);
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
): TuneResult {
  // WAVE-3b: delegate to the Bayesian tuner when enabled (default off).
  const bayes = delegateBayes(doc, bars, opts, range, nTrials, seed);
  if (bayes) { const { configs, ...r } = bayes; void configs; return r; }
  const rng = mulberry32(seed);
  const specs = doc.params ?? {};
  const hasParams = Object.keys(specs).length > 0;
  let best: TuneResult | null = null;
  const evalOne = (params: Record<string, number>): TuneResult => {
    const res = runBacktest(doc, bars, params, opts, range);
    return { params, objective: objective(res.metrics.sharpe, res.metrics.trades), sharpe: res.metrics.sharpe, trades: res.metrics.trades };
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
): TuneResult & { configs: { params: Record<string, number>; objective: number; sharpe: number }[] } {
  // WAVE-3b: delegate to the Bayesian tuner when enabled (default off). It
  // returns the same {..., configs} shape so the PBO probe is unaffected.
  const bayes = delegateBayes(doc, bars, opts, range, nTrials, seed);
  if (bayes) return bayes;
  const rng = mulberry32(seed);
  const specs = doc.params ?? {};
  const hasParams = Object.keys(specs).length > 0;
  const configs: { params: Record<string, number>; objective: number; sharpe: number }[] = [];
  let best: TuneResult | null = null;
  const evalOne = (params: Record<string, number>): TuneResult => {
    const res = runBacktest(doc, bars, params, opts, range);
    const r = { params, objective: objective(res.metrics.sharpe, res.metrics.trades), sharpe: res.metrics.sharpe, trades: res.metrics.trades };
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
