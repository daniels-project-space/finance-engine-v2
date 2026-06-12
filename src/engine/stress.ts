// Stress battery: slippage ramp, parameter perturbation, crisis replay, DD shuffle.

import { runBacktest, indexOfTs } from "./backtest";
import { mulberry32, shuffleDDPercentile } from "./stats";
import type { BacktestOpts, Bars, StrategyDoc } from "./types";

export interface StressReport {
  baseSharpe: number;
  slipRamp: { mult: number; sharpe: number }[];
  slipSurvives: boolean;        // sharpe@3x slip > 50% of base
  perturbedMeanSharpe: number;
  perturbSurvives: boolean;     // mean of ±15% param perturbations > 60% of base
  crisis: { name: string; ret: number; maxDD: number }[];
  crisisSurvives: boolean;      // no crisis window with DD worse than floor
  ddShufflePct: number;         // fraction of shuffles with deeper DD than observed (high = path was lucky-ish ordering matters less)
}

/** Crisis windows that fall inside our data range (ms UTC). */
export const CRISIS_WINDOWS: { name: string; from: number; to: number }[] = [
  { name: "2021-05 leverage flush", from: Date.UTC(2021, 4, 10), to: Date.UTC(2021, 5, 1) },
  { name: "2021-12 derisk", from: Date.UTC(2021, 11, 1), to: Date.UTC(2022, 0, 25) },
  { name: "2022-05 LUNA", from: Date.UTC(2022, 4, 5), to: Date.UTC(2022, 4, 31) },
  { name: "2022-06 3AC/Celsius", from: Date.UTC(2022, 5, 8), to: Date.UTC(2022, 6, 1) },
  { name: "2022-11 FTX", from: Date.UTC(2022, 10, 2), to: Date.UTC(2022, 10, 30) },
  { name: "2023-03 USDC depeg", from: Date.UTC(2023, 2, 9), to: Date.UTC(2023, 2, 20) },
  { name: "2024-08 yen unwind", from: Date.UTC(2024, 7, 1), to: Date.UTC(2024, 7, 15) },
];

export function runStress(
  doc: StrategyDoc,
  bars: Bars,
  params: Record<string, number>,
  opts: BacktestOpts,
  floors: { slipMult: number; crisisMaxDD: number },
  range?: { startI?: number; endI?: number },
): StressReport {
  const base = runBacktest(doc, bars, params, opts, range);
  const baseSharpe = base.metrics.sharpe;

  // slippage ramp
  const slipRamp = [1, 2, 3, 5].map((mult) => ({
    mult,
    sharpe: mult === 1 ? baseSharpe : runBacktest(doc, bars, params, { ...opts, slipMult: mult }, range).metrics.sharpe,
  }));
  const at3 = slipRamp.find((s) => s.mult === floors.slipMult)?.sharpe ?? 0;
  const slipSurvives = baseSharpe > 0 && at3 > 0.5 * baseSharpe;

  // parameter perturbation ±15%
  const rng = mulberry32(99);
  const keys = Object.keys(params);
  let perturbedMeanSharpe = baseSharpe;
  if (keys.length > 0) {
    const sharpes: number[] = [];
    for (let s = 0; s < 8; s++) {
      const p: Record<string, number> = {};
      for (const k of keys) {
        const spec = doc.params[k];
        let v = params[k] * (1 + (rng() * 2 - 1) * 0.15);
        v = Math.min(spec.max, Math.max(spec.min, v));
        if (spec.int) v = Math.round(v);
        p[k] = v;
      }
      sharpes.push(runBacktest(doc, bars, p, opts, range).metrics.sharpe);
    }
    perturbedMeanSharpe = sharpes.reduce((a, b) => a + b, 0) / sharpes.length;
  }
  const perturbSurvives = baseSharpe <= 0 ? false : perturbedMeanSharpe > 0.6 * baseSharpe;

  // crisis replay
  const crisis: { name: string; ret: number; maxDD: number }[] = [];
  for (const cw of CRISIS_WINDOWS) {
    const a = indexOfTs(bars.t, cw.from);
    const b = indexOfTs(bars.t, cw.to) - 1;
    if (b - a < 48) continue; // window not in data range
    // warm indicators with 1000 bars of runway before the window
    const warmStart = Math.max(1, a - 1000);
    const res = runBacktest(doc, bars, params, opts, { startI: warmStart, endI: b });
    let g = 1, eq = 1, peak = 1, dd = 0;
    for (let i = a; i <= b; i++) { g *= 1 + res.ret[i]; eq *= 1 + res.ret[i]; if (eq > peak) peak = eq; const d = eq / peak - 1; if (d < dd) dd = d; }
    crisis.push({ name: cw.name, ret: g - 1, maxDD: dd });
  }
  const crisisSurvives = crisis.every((c) => c.maxDD > floors.crisisMaxDD);

  const from = Math.max(1, range?.startI ?? 0) + 1;
  const to = Math.min(bars.c.length - 1, range?.endI ?? bars.c.length - 1);
  const ddShufflePct = shuffleDDPercentile(base.ret, from, to, base.metrics.maxDD);

  return { baseSharpe, slipRamp, slipSurvives, perturbedMeanSharpe, perturbSurvives, crisis, crisisSurvives, ddShufflePct };
}
