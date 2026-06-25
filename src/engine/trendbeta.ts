// TREND-BETA sleeve — RISK-MANAGED LONG BETA (the "safer than HODL" family).
//
// Long-flat single-coin (BTC/ETH/SOL) perp: LONG when close > SMA(win), else FLAT.
// The session's best feasibility result: on real 5y data the trend filter beat BTC
// HODL's return at ~40% of the drawdown (HODL -77% maxDD -> ~-32%), robust under
// honest purged WF, Calmar ~0.7 vs ~0. NOT orthogonal alpha — this CAPTURES BTC's
// upside while sitting out the worst bears. ONE param (smaWin), monotone family,
// point-in-time SMA (no look-ahead), realistic costs (fee+slip on flips + funding
// while long). Long-flat (weight in {0,1}); modest leverage only if maxLeverage>1.
//
// Produces ONE OOS return stream, so it routes through the adapted gauntlet (S4
// cross-symbol skipped) + the book gate, like ivsleeve/onchain.

import { type Bars, PPY } from "./types";

export interface TrendBetaDoc {
  name: string;
  kind: "trendbeta";
  hypothesis: string;
  symbol: string;             // "BTC/USDT" | "ETH/USDT" | "SOL/USDT"
  tf: "1d";
  smaWin: number;             // trailing SMA window (days); long when close > SMA
  params: Record<string, { min: number; max: number; default: number; int?: boolean }>;
  risk: { volTargetAnnual: number; maxLeverage: number }; // maxLeverage default 1 (long-flat)
}

export function isTrendBeta(doc: unknown): doc is TrendBetaDoc {
  return !!doc && typeof doc === "object" && (doc as { kind?: string }).kind === "trendbeta";
}

const FEE_BPS = 5;
const SLIP_BPS_D: Record<string, number> = { "BTC/USDT": 1.5, "ETH/USDT": 2, "SOL/USDT": 3 };

/** Daily-aligned inputs: perp daily returns + per-day funding (point-in-time). */
export interface TrendDaily { t: number[]; ret: number[]; close: number[]; funding: number[] }

/** Build the daily series from 1d perp bars. Point-in-time (no future info). */
export function buildTrendDaily(bars: Bars): TrendDaily {
  const t = bars.t.slice(), close = bars.c.slice();
  const ret: number[] = [0];
  for (let i = 1; i < close.length; i++) ret.push(close[i - 1] > 0 ? close[i] / close[i - 1] - 1 : 0);
  const fmap = new Map<number, number>();
  if (bars.fundingT && bars.fundingR) for (let i = 0; i < bars.fundingT.length; i++) { const day = Math.floor(bars.fundingT[i] / 86400000) * 86400000; fmap.set(day, (fmap.get(day) ?? 0) + bars.fundingR[i]); }
  const funding = t.map((ts) => fmap.get(Math.floor(ts / 86400000) * 86400000) ?? 0);
  return { t, ret, close, funding };
}

/** SMA of closes over (i-win, i] — uses ONLY bars <= i (point-in-time). */
function smaAt(close: number[], i: number, win: number): number {
  if (i < win) return NaN;
  let s = 0; for (let k = i - win + 1; k <= i; k++) s += close[k];
  return s / win;
}

export interface TrendBacktest { ret: Float64Array; t: number[]; exposure: number; flips: number }

/** Long-flat trend-filter backtest over [startI,endI]. The weight DECIDED at close
 *  of day i (close_i vs SMA computed from closes <= i) earns day i+1's return.
 *  Charges fee+slip on flips and the day's funding while long. */
export function backtestTrend(doc: TrendBetaDoc, S: TrendDaily, params: Record<string, number>, range?: { startI?: number; endI?: number }): TrendBacktest {
  const n = S.t.length;
  const win = Math.max(20, Math.round(params.smaWin ?? doc.smaWin));
  const maxLev = Math.max(1, doc.risk.maxLeverage ?? 1);
  const slip = SLIP_BPS_D[doc.symbol] ?? 3;
  const warm = win + 1;
  const startI = Math.max(warm, range?.startI ?? warm);
  const endI = Math.min(n - 1, range?.endI ?? n - 1);
  // target weight at each day i (info <= i): long if close_i > SMA_i
  const w = new Float64Array(n);
  for (let i = startI; i <= endI; i++) {
    const sma = smaAt(S.close, i, win);
    w[i] = Number.isFinite(sma) && S.close[i] > sma ? maxLev : 0;
  }
  const out = new Float64Array(n);
  let exp = 0, flips = 0;
  for (let i = startI + 1; i <= endI; i++) {
    const wk = w[i - 1];                         // weight decided at i-1 earns day i
    const dw = Math.abs(w[i - 1] - (w[i - 2] ?? 0));
    if (dw > 0) flips++;
    out[i] = wk * S.ret[i] - dw * (FEE_BPS + slip) / 1e4 - wk * S.funding[i];
    exp += wk > 0 ? 1 : 0;
  }
  return { ret: out, t: S.t, exposure: exp / Math.max(1, endI - startI), flips };
}

export interface TrendWfReport { pooledRet: Float64Array; pooledT: Float64Array; pooledSharpe: number; pctPositive: number; pooledMaxDD: number; worstWindowRet: number; windows: number; bestParamsByWindow: Record<string, number>[] }

const MS_30D = 30 * 24 * 3600 * 1000;
function sharpe(ret: Float64Array, from: number, to: number): number { let s = 0, sq = 0, n = 0; for (let i = Math.max(0, from); i <= to && i < ret.length; i++) { s += ret[i]; sq += ret[i] * ret[i]; n++; } if (n < 2) return 0; const m = s / n, sd = Math.sqrt(Math.max(0, sq / n - m * m)); return sd > 1e-12 ? (m / sd) * Math.sqrt(365) : 0; }

/** Purged WF re-selecting smaWin per window on the trend stream (one param,
 *  monotone family). Trains on the trailing year, trades OOS the next ~quarter. */
export function walkForwardTrend(doc: TrendBetaDoc, S: TrendDaily, cfg: { trainMonths?: number; stepMonths?: number; endTs?: number } = {}): TrendWfReport {
  // 18-month train so it still clears the minimum AFTER the purge gap; quarterly step.
  const trainMs = (cfg.trainMonths ?? 18) * MS_30D, stepMs = (cfg.stepMonths ?? 3) * MS_30D;
  const endTs = cfg.endTs ?? S.t[S.t.length - 1], startTs = S.t[0];
  const idxOf = (ts: number): number => { let lo = 0, hi = S.t.length - 1, r = S.t.length; while (lo <= hi) { const m = (lo + hi) >> 1; if (S.t[m] >= ts) { r = m; hi = m - 1; } else lo = m + 1; } return r; };
  const wins = [100, 150, 200, 250];          // the monotone grid (one param)
  const pooled: number[] = [], pooledT: number[] = []; const byWin: Record<string, number>[] = [];
  let testStart = startTs + trainMs;
  while (testStart + stepMs <= endTs + stepMs && idxOf(testStart) < S.t.length) {
    // purge = embargo gap between train end and test start. The SMA at a test day
    // only reads closes within `smaWin` BEFORE it; a 5-day embargo (well past any
    // intraday overlap) cleanly separates train/test without gutting the train.
    const purge = 5;
    const trainStartI = idxOf(testStart - trainMs), trainEndI = idxOf(testStart) - 1 - purge;
    const testStartI = idxOf(testStart), testEndI = Math.min(S.t.length - 1, idxOf(Math.min(testStart + stepMs, endTs + stepMs)) - 1);
    if (testEndI <= testStartI + 5 || trainEndI - trainStartI < 120) { testStart += stepMs; continue; }
    let best: { p: Record<string, number>; sh: number } | null = null;
    for (const win of wins) {
      const bt = backtestTrend(doc, S, { smaWin: win }, { startI: trainStartI, endI: trainEndI });
      const sh = sharpe(bt.ret, trainStartI + 1, trainEndI);
      if (!best || sh > best.sh) best = { p: { smaWin: win }, sh };
    }
    const bt = backtestTrend(doc, S, best!.p, { startI: trainStartI, endI: testEndI });
    for (let i = testStartI; i <= testEndI; i++) { pooled.push(bt.ret[i]); pooledT.push(S.t[i]); }
    byWin.push(best!.p);
    testStart += stepMs;
  }
  const pooledRet = Float64Array.from(pooled);
  const sh = sharpe(pooledRet, 0, pooledRet.length - 1);
  const perMonth = Math.max(1, Math.floor(365 / 12)); let pos = 0, mo = 0, worst = 0;
  for (let i = 0; i < pooled.length; i += perMonth) { let g = 1; for (let j = i; j < Math.min(i + perMonth, pooled.length); j++) g *= 1 + pooled[j]; const r = g - 1; if (r > 0) pos++; if (r < worst) worst = r; mo++; }
  let eq = 1, peak = 1, maxDD = 0; for (const r of pooled) { eq *= 1 + r; if (eq > peak) peak = eq; const d = eq / peak - 1; if (d < maxDD) maxDD = d; }
  return { pooledRet, pooledT: Float64Array.from(pooledT), pooledSharpe: sh, pctPositive: mo ? pos / mo : 0, pooledMaxDD: maxDD, worstWindowRet: worst, windows: byWin.length, bestParamsByWindow: byWin };
}

/** HODL (buy & hold) return stream for the same coin/window — the benchmark the
 *  sleeve must beat on Calmar/maxDD. Long always, funding charged (perp-apples). */
export function hodlStream(S: TrendDaily, startI: number): Float64Array {
  const out = new Float64Array(S.t.length);
  for (let i = startI + 1; i < S.t.length; i++) out[i] = S.ret[i] - S.funding[i];
  return out;
}

void PPY;
