// Weight-based, strictly causal backtester for perpetual futures.
//
// Discipline against look-ahead:
//  - signals[i] are computed from data up to and including bar i's close
//  - the weight DECIDED at close of bar i earns the return of bar i+1
//  - turnover costs are charged on the bar where the new weight takes effect
//  - stops are evaluated on close, exit takes effect next bar (conservative)
// Funding: perp funding (8h) charged as w * rate at the first bar whose open
// time is >= the funding timestamp. Long pays positive funding.

import { computeSignals, toArrays, type CompiledInputs } from "./compile";
import { type BacktestOpts, type BacktestResult, type Bars, type Metrics, type StrategyDoc, type Trade } from "./types";

const EWMA_LAMBDA = 0.94;

export function runBacktest(
  doc: StrategyDoc,
  bars: Bars,
  params: Record<string, number>,
  opts: BacktestOpts,
  range?: { startI?: number; endI?: number },
): BacktestResult {
  const inp = toArrays(bars);
  return runBacktestPrepared(doc, bars, inp, params, opts, range);
}

/** Variant that reuses pre-built Float64Arrays (hot path for tuning loops). */
export function runBacktestPrepared(
  doc: StrategyDoc,
  bars: Bars,
  inp: CompiledInputs,
  params: Record<string, number>,
  opts: BacktestOpts,
  range?: { startI?: number; endI?: number },
): BacktestResult {
  const n = inp.c.length;
  const startI = Math.max(1, range?.startI ?? 0);
  const endI = Math.min(n - 1, range?.endI ?? n - 1);
  const sig = computeSignals(doc, inp, params);

  const slipMult = opts.slipMult ?? 1;
  const costRate = (opts.cost.feeBps + opts.cost.slipBps * slipMult) / 10_000;

  // --- pass 1: decide weights at each bar close ---------------------------
  const w = new Float64Array(n); // w[i] = weight held during bar i+1
  let dir: 0 | 1 | -1 = 0;
  let entryPx = NaN;
  let stopLevel = NaN;
  let trailRef = NaN;
  let ewmaVar = 0;
  let ewmaInit = false;
  const trades: Trade[] = [];
  let openEntryI = -1;

  const { stopAtrMult, trailAtrMult, volTargetAnnual, maxLeverage } = doc.risk;
  const perBarTargetVar = (volTargetAnnual * volTargetAnnual) / opts.ppy;

  for (let i = startI; i <= endI; i++) {
    const r = inp.c[i - 1] > 0 ? inp.c[i] / inp.c[i - 1] - 1 : 0;
    // update realized vol estimate (causal, uses bar i return)
    if (!ewmaInit) { ewmaVar = r * r; ewmaInit = true; }
    else ewmaVar = EWMA_LAMBDA * ewmaVar + (1 - EWMA_LAMBDA) * r * r;

    // --- stop checks on close (exit takes effect next bar) ---
    let stopHit = false;
    if (dir !== 0 && !Number.isNaN(stopLevel)) {
      if (dir === 1 && inp.c[i] <= stopLevel) stopHit = true;
      if (dir === -1 && inp.c[i] >= stopLevel) stopHit = true;
    }
    if (dir !== 0 && trailAtrMult && !Number.isNaN(sig.atr14[i])) {
      if (dir === 1) {
        trailRef = Math.max(trailRef, inp.c[i]);
        const trail = trailRef - trailAtrMult * sig.atr14[i];
        stopLevel = Number.isNaN(stopLevel) ? trail : Math.max(stopLevel, trail);
      } else {
        trailRef = Math.min(trailRef, inp.c[i]);
        const trail = trailRef + trailAtrMult * sig.atr14[i];
        stopLevel = Number.isNaN(stopLevel) ? trail : Math.min(stopLevel, trail);
      }
    }

    // --- state machine ---
    let newDir: 0 | 1 | -1 = dir;
    if (dir === 1 && (sig.longExit[i] || stopHit)) newDir = 0;
    else if (dir === -1 && ((sig.shortExit && sig.shortExit[i]) || stopHit)) newDir = 0;
    if (newDir === 0) {
      if (sig.longEntry[i]) newDir = 1;
      else if (sig.shortEntry && sig.shortEntry[i]) newDir = -1;
    }

    if (newDir !== dir) {
      if (dir !== 0 && openEntryI >= 0) {
        trades.push({ entryI: openEntryI, exitI: i, dir: dir as 1 | -1, entryTs: bars.t[openEntryI], exitTs: bars.t[i], ret: 0 });
        openEntryI = -1;
      }
      if (newDir !== 0) {
        openEntryI = i;
        entryPx = inp.c[i];
        trailRef = inp.c[i];
        stopLevel = stopAtrMult && !Number.isNaN(sig.atr14[i])
          ? (newDir === 1 ? entryPx - stopAtrMult * sig.atr14[i] : entryPx + stopAtrMult * sig.atr14[i])
          : NaN;
      } else {
        stopLevel = NaN; trailRef = NaN;
      }
      dir = newDir;
    }

    // --- vol-targeted sizing ---
    if (dir === 0) { w[i] = 0; continue; }
    const scale = ewmaVar > 1e-12 ? Math.sqrt(perBarTargetVar / ewmaVar) : 1;
    w[i] = dir * Math.min(maxLeverage, Math.max(0, scale));
  }
  if (dir !== 0 && openEntryI >= 0) {
    trades.push({ entryI: openEntryI, exitI: endI, dir: dir as 1 | -1, entryTs: bars.t[openEntryI], exitTs: bars.t[endI], ret: 0 });
  }

  // --- funding map: bar index -> rate ---
  const fundingAtBar = new Float64Array(n);
  if (bars.fundingT && bars.fundingR) {
    let bi = startI;
    for (let fi = 0; fi < bars.fundingT.length; fi++) {
      const ft = bars.fundingT[fi];
      while (bi <= endI && bars.t[bi] < ft) bi++;
      if (bi > endI) break;
      fundingAtBar[bi] += bars.fundingR[fi];
    }
  }

  // --- pass 2: returns ----------------------------------------------------
  const ret = new Float64Array(n);
  const equity = new Float64Array(n).fill(opts.startEquity ?? 1);
  let turnoverSum = 0;
  let exposureBars = 0;
  let bust = false; // leverage honesty: a blown account stays blown
  const startEq = opts.startEquity ?? 1;
  for (let i = startI + 1; i <= endI; i++) {
    if (bust) { ret[i] = 0; equity[i] = equity[i - 1]; continue; }
    const r = inp.c[i - 1] > 0 ? inp.c[i] / inp.c[i - 1] - 1 : 0;
    const held = w[i - 1];
    const turnover = Math.abs(w[i - 1] - (i - 2 >= startI - 1 ? w[i - 2] : 0));
    turnoverSum += turnover;
    const fundingCost = held * fundingAtBar[i];
    ret[i] = Math.max(-0.95, held * r - turnover * costRate - fundingCost);
    equity[i] = equity[i - 1] * (1 + ret[i]);
    if (held !== 0) exposureBars++;
    if (equity[i] <= 0.05 * startEq) bust = true; // margin death — no resurrection
  }
  for (let i = 0; i < startI + 1; i++) equity[i] = opts.startEquity ?? 1;

  // trade returns from equity path
  for (const tr of trades) {
    const a = Math.min(tr.entryI + 1, endI);
    tr.ret = equity[tr.entryI] > 0 ? equity[Math.min(tr.exitI + 1, endI)] / equity[a > 0 ? a - 1 : 0] - 1 : 0;
  }

  const metrics = computeMetrics(ret, equity, bars.t, trades, startI + 1, endI, opts.ppy, turnoverSum, exposureBars);
  return { ret, equity, weights: w, metrics, trades };
}

export function computeMetrics(
  ret: Float64Array, equity: Float64Array, ts: number[], trades: Trade[],
  from: number, to: number, ppy: number, turnoverSum: number, exposureBars: number,
): Metrics {
  const nBars = Math.max(1, to - from + 1);
  let sum = 0, sumSq = 0, downSq = 0, downN = 0;
  for (let i = from; i <= to; i++) { const r = ret[i]; sum += r; sumSq += r * r; if (r < 0) { downSq += r * r; downN++; } }
  const mean = sum / nBars;
  const variance = Math.max(0, sumSq / nBars - mean * mean);
  const sd = Math.sqrt(variance);
  const sharpe = sd > 1e-12 ? (mean / sd) * Math.sqrt(ppy) : 0;
  const downSd = downN > 0 ? Math.sqrt(downSq / nBars) : 0;
  const sortino = downSd > 1e-12 ? (mean / downSd) * Math.sqrt(ppy) : 0;

  let peak = -Infinity, maxDD = 0;
  for (let i = from; i <= to; i++) {
    if (equity[i] > peak) peak = equity[i];
    const dd = equity[i] / peak - 1;
    if (dd < maxDD) maxDD = dd;
  }
  const totalReturn = equity[to] / equity[Math.max(0, from - 1)] - 1;
  const years = nBars / ppy;
  const cagr = years > 0 && 1 + totalReturn > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : -1;
  const calmar = maxDD < 0 ? cagr / Math.abs(maxDD) : cagr > 0 ? 99 : 0;

  const wins = trades.filter((t) => t.ret > 0).length;
  // compounded monthly returns
  const monthly = new Map<string, number>();
  for (let i = from; i <= to; i++) {
    const d = new Date(ts[i]);
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    monthly.set(ym, ((monthly.get(ym) ?? 1) as number) * (1 + ret[i]));
  }
  const monthlyReturns = Array.from(monthly.entries()).map(([ym, g]) => ({ ym, ret: g - 1 })).sort((a, b) => a.ym.localeCompare(b.ym));

  return {
    bars: nBars,
    totalReturn,
    cagr,
    sharpe,
    sortino,
    maxDD,
    calmar,
    trades: trades.length,
    winRate: trades.length ? wins / trades.length : 0,
    avgTradeRet: trades.length ? trades.reduce((s, t) => s + t.ret, 0) / trades.length : 0,
    exposure: exposureBars / nBars,
    turnoverPerYear: (turnoverSum / nBars) * ppy,
    monthlyReturns,
  };
}

/** Slice helper: index of first bar with t >= ts (binary search). */
export function indexOfTs(t: number[], ts: number): number {
  let lo = 0, hi = t.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (t[mid] < ts) lo = mid + 1; else hi = mid; }
  return lo;
}
