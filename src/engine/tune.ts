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

export function tune(
  doc: StrategyDoc,
  bars: Bars,
  opts: BacktestOpts,
  range: { startI: number; endI: number },
  nTrials = 60,
  seed = 11,
): TuneResult {
  const rng = mulberry32(seed);
  const hasParams = Object.keys(doc.params ?? {}).length > 0;
  let best: TuneResult | null = null;
  const trials = hasParams ? nTrials : 1;
  for (let t = 0; t < trials; t++) {
    const params = t === 0
      ? Object.fromEntries(Object.entries(doc.params ?? {}).map(([k, p]) => [k, p.default]))
      : sampleParams(doc, rng);
    const res = runBacktest(doc, bars, params, opts, range);
    const obj = objective(res.metrics.sharpe, res.metrics.trades);
    if (!best || obj > best.objective) {
      best = { params, objective: obj, sharpe: res.metrics.sharpe, trades: res.metrics.trades };
    }
  }
  return best as TuneResult;
}
