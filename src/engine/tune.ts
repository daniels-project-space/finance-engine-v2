// Deterministic random-search tuner. Tuning ONLY ever sees the slice of data
// it is given — walk-forward and seal discipline live in the callers.

import { runBacktest } from "./backtest";
import { mulberry32 } from "./stats";
import type { BacktestOpts, Bars, StrategyDoc } from "./types";

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
