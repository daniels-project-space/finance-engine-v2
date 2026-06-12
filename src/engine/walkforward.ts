// TRUE re-tuning walk-forward: for each monthly OOS window, parameters are
// re-fit on the trailing train span only, then traded out-of-sample. The old
// engine's "walk-forward" never re-tuned — this one does, by construction.

import { runBacktest, computeMetrics, indexOfTs } from "./backtest";
import { tune } from "./tune";
import type { BacktestOpts, Bars, StrategyDoc } from "./types";

export interface WfWindow {
  trainStartTs: number; testStartTs: number; testEndTs: number;
  params: Record<string, number>;
  oosSharpe: number; oosRet: number; oosTrades: number;
}

export interface WfReport {
  windows: WfWindow[];
  pooledSharpe: number;
  meanWindowSharpe: number;
  pctPositive: number;
  worstWindowRet: number;
  pooledMaxDD: number;
  pooledRet: Float64Array; // concatenated OOS returns (for stats downstream)
  pooledT: Float64Array;   // bar timestamps aligned with pooledRet (for portfolio assembly)
  totalOosTrades: number;
}

const MS_30D = 30 * 24 * 3600 * 1000;

export function walkForward(
  doc: StrategyDoc,
  bars: Bars,
  opts: BacktestOpts,
  cfg: { trainMonths?: number; stepMonths?: number; minWindows?: number; tuneTrials?: number; endTs?: number } = {},
): WfReport {
  const trainMs = (cfg.trainMonths ?? 12) * MS_30D;
  const stepMs = (cfg.stepMonths ?? 1) * MS_30D;
  const endTs = cfg.endTs ?? bars.t[bars.t.length - 1];
  const startTs = bars.t[0];

  const windows: WfWindow[] = [];
  const pooled: number[] = [];
  const pooledTs: number[] = [];
  let totalOosTrades = 0;

  let testStart = startTs + trainMs;
  let wi = 0;
  while (testStart + stepMs <= endTs) {
    const trainStartI = indexOfTs(bars.t, testStart - trainMs);
    const trainEndI = indexOfTs(bars.t, testStart) - 1;
    const testEndTs = Math.min(testStart + stepMs, endTs);
    const testStartI = trainEndI + 1;
    const testEndI = indexOfTs(bars.t, testEndTs) - 1;
    // minimum usable train span scales with the bar size (1h≈3500, 4h≈875, 1d≈145)
    const minTrainBars = Math.max(100, Math.floor(0.4 * (cfg.trainMonths ?? 12) * (opts.ppy / 12)));
    if (testEndI <= testStartI + 8 || trainEndI - trainStartI < minTrainBars) { testStart += stepMs; continue; }

    const fit = tune(doc, bars, opts, { startI: trainStartI, endI: trainEndI }, cfg.tuneTrials ?? 40, 1000 + wi);
    // run from train start so indicators are warm, but score only the test slice
    const res = runBacktest(doc, bars, fit.params, opts, { startI: trainStartI, endI: testEndI });
    let s = 0, sq = 0, g = 1, trades = 0;
    for (let i = testStartI; i <= testEndI; i++) { const r = res.ret[i]; s += r; sq += r * r; g *= 1 + r; }
    for (const tr of res.trades) if (tr.entryI >= testStartI) trades++;
    const n = testEndI - testStartI + 1;
    const mean = s / n, sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
    const oosSharpe = sd > 1e-12 ? (mean / sd) * Math.sqrt(opts.ppy) : 0;
    windows.push({ trainStartTs: bars.t[trainStartI], testStartTs: testStart, testEndTs, params: fit.params, oosSharpe, oosRet: g - 1, oosTrades: trades });
    for (let i = testStartI; i <= testEndI; i++) { pooled.push(res.ret[i]); pooledTs.push(bars.t[i]); }
    totalOosTrades += trades;
    testStart += stepMs;
    wi++;
  }

  const pooledRet = Float64Array.from(pooled);
  let s = 0, sq = 0;
  for (const r of pooled) { s += r; sq += r * r; }
  const n = Math.max(1, pooled.length);
  const mean = s / n, sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
  const pooledSharpe = sd > 1e-12 ? (mean / sd) * Math.sqrt(opts.ppy) : 0;
  let eq = 1, peak = 1, maxDD = 0;
  for (const r of pooled) { eq *= 1 + r; if (eq > peak) peak = eq; const d = eq / peak - 1; if (d < maxDD) maxDD = d; }

  return {
    windows,
    pooledSharpe,
    meanWindowSharpe: windows.length ? windows.reduce((a, w) => a + w.oosSharpe, 0) / windows.length : 0,
    pctPositive: windows.length ? windows.filter((w) => w.oosRet > 0).length / windows.length : 0,
    worstWindowRet: windows.length ? Math.min(...windows.map((w) => w.oosRet)) : 0,
    pooledMaxDD: maxDD,
    pooledRet,
    pooledT: Float64Array.from(pooledTs),
    totalOosTrades,
  };
}
