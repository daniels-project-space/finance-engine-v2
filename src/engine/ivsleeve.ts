// IV-TIMING sleeve — the first genuinely-orthogonal (options-IV) diversifier.
//
// Long-flat single-coin (BTC or ETH) perp timing driven by the Deribit DVOL
// implied-vol regime / IV-RV spread. Productionizes the spike's winning signals:
//   - dvol_high:  long when the DVOL z-score is high (high-vol regime)
//   - ivrv_high:  long when (DVOL - realized vol) z-score is high (vol-premium rich)
// LONG-FLAT (weight in {0,1}), point-in-time DVOL (no look-ahead), realistic costs
// (fee+slip+funding). DVOL exists ONLY for BTC & ETH — this sleeve is BTC/ETH only.
//
// It produces ONE OOS return stream, so it routes through a dedicated gauntlet
// path (like xsection) and the book-marginal gate — its whole purpose is to enter
// the book as the orthogonal component.

import { type Bars, PPY } from "./types";
import type { DvolSeries } from "../lib/deribit";

export type IvSignal = "dvol_high" | "ivrv_high" | "dvol_low" | "ivrv_low";

export interface IvSleeveDoc {
  name: string;
  kind: "ivsleeve";
  hypothesis: string;
  symbol: string;          // "BTC/USDT" | "ETH/USDT"
  tf: "1d";                // DVOL is daily
  signal: IvSignal;
  zWin: number;            // trailing window for the DVOL/IV-RV z-score
  thresh: number;          // z-score threshold to be long
  rvWin: number;           // trailing window for realized vol (for IV-RV)
  params: Record<string, { min: number; max: number; default: number; int?: boolean }>;
  risk: { volTargetAnnual: number; maxLeverage: number };
}

export function isIvSleeve(doc: unknown): doc is IvSleeveDoc {
  return !!doc && typeof doc === "object" && (doc as { kind?: string }).kind === "ivsleeve";
}

const FEE_BPS = 5; // matches DEFAULT_FEE_BPS
const SLIP_BPS_D: Record<string, number> = { "BTC/USDT": 1.5, "ETH/USDT": 2 };

/** Daily-aligned inputs: perp daily returns + DVOL + trailing realized vol (annualized %). */
export interface IvDaily { t: number[]; ret: number[]; dvol: number[]; rv: number[]; funding: number[] }

/** Build the daily series for a coin from its 1d perp bars + DVOL map. Point-in-time. */
export function buildIvDaily(bars: Bars, dvol: Map<number, number>, rvWin = 20): IvDaily {
  const t: number[] = [], ret: number[] = [], dv: number[] = [], rv: number[] = [], fund: number[] = [];
  const dr: number[] = [0];
  for (let i = 1; i < bars.c.length; i++) dr.push(bars.c[i - 1] > 0 ? bars.c[i] / bars.c[i - 1] - 1 : 0);
  // per-day funding (sum of stamps within the day), point-in-time
  const fmap = new Map<number, number>();
  if (bars.fundingT && bars.fundingR) for (let i = 0; i < bars.fundingT.length; i++) { const day = Math.floor(bars.fundingT[i] / 86400000) * 86400000; fmap.set(day, (fmap.get(day) ?? 0) + bars.fundingR[i]); }
  for (let i = 0; i < bars.t.length; i++) {
    const day = Math.floor(bars.t[i] / 86400000) * 86400000;
    const d = dvol.get(day);
    if (d === undefined) continue;
    let s = 0, sq = 0, n = 0;
    for (let k = Math.max(1, i - rvWin); k <= i; k++) { s += dr[k]; sq += dr[k] * dr[k]; n++; }
    const sd = n > 5 ? Math.sqrt(Math.max(0, sq / n - (s / n) ** 2)) : 0;
    t.push(bars.t[i]); ret.push(dr[i]); dv.push(d); rv.push(sd * Math.sqrt(365) * 100); fund.push(fmap.get(day) ?? 0);
  }
  return { t, ret, dvol: dv, rv, funding: fund };
}

/** Trailing z-score of arr at i over win, using ONLY bars < i (point-in-time). */
function zPast(arr: number[], i: number, win: number): number {
  const lo = Math.max(0, i - win); let s = 0, sq = 0, n = 0;
  for (let k = lo; k < i; k++) { s += arr[k]; sq += arr[k] * arr[k]; n++; }
  if (n < 20) return 0;
  const m = s / n, sd = Math.sqrt(Math.max(1e-12, sq / n - m * m));
  return (arr[i] - m) / sd;
}

export interface IvBacktest { ret: Float64Array; t: number[]; exposure: number; flips: number }

/** Backtest the long-flat IV-timing sleeve over [startI, endI]. The weight DECIDED
 *  at close of day i (from info <= i) earns day i+1's return. Charges fee+slip on
 *  flips and the day's funding while long. */
export function backtestIv(doc: IvSleeveDoc, S: IvDaily, params: Record<string, number>, range?: { startI?: number; endI?: number }): IvBacktest {
  const n = S.t.length;
  const zWin = Math.max(20, Math.round(params.zWin ?? doc.zWin));
  const thresh = params.thresh ?? doc.thresh;
  const slip = SLIP_BPS_D[doc.symbol] ?? 2;
  const ivrv = S.dvol.map((d, i) => d - S.rv[i]);
  const warm = Math.max(zWin + 1, doc.rvWin + 2);
  const startI = Math.max(warm, range?.startI ?? warm);
  const endI = Math.min(n - 1, range?.endI ?? n - 1);
  const w = new Float64Array(n);
  for (let i = startI; i <= endI; i++) {
    let want = 0;
    if (doc.signal === "dvol_high") want = zPast(S.dvol, i, zWin) > thresh ? 1 : 0;
    else if (doc.signal === "dvol_low") want = zPast(S.dvol, i, zWin) < -thresh ? 1 : 0;
    else if (doc.signal === "ivrv_high") want = zPast(ivrv, i, zWin) > thresh ? 1 : 0;
    else want = zPast(ivrv, i, zWin) < -thresh ? 1 : 0;
    w[i] = want;
  }
  const out = new Float64Array(n);
  let exp = 0, flips = 0;
  for (let i = startI + 1; i <= endI; i++) {
    const wk = w[i - 1];                       // weight decided at i-1 earns day i
    const dw = Math.abs(w[i - 1] - (w[i - 2] ?? 0));
    if (dw > 0) flips++;
    // long pays positive funding; charge it while long
    out[i] = wk * S.ret[i] - dw * (FEE_BPS + slip) / 1e4 - wk * S.funding[i];
    exp += wk;
  }
  // vol-target the (sparse) stream to the risk target, cap leverage
  let s = 0, sq = 0, c = 0; for (let i = startI + 1; i <= endI; i++) { s += out[i]; sq += out[i] * out[i]; c++; }
  const sd = Math.sqrt(Math.max(0, sq / Math.max(1, c) - (s / Math.max(1, c)) ** 2));
  const annVol = sd * Math.sqrt(365);
  const lev = annVol > 1e-9 ? Math.min(doc.risk.maxLeverage, doc.risk.volTargetAnnual / annVol) : 1;
  const scaled = new Float64Array(n);
  for (let i = startI + 1; i <= endI; i++) scaled[i] = Math.max(-0.95, out[i] * lev);
  return { ret: scaled, t: S.t, exposure: exp / Math.max(1, endI - startI), flips };
}

export interface IvWfReport { pooledRet: Float64Array; pooledT: Float64Array; pooledSharpe: number; pctPositive: number; pooledMaxDD: number; worstWindowRet: number; windows: number; bestParamsByWindow: Record<string, number>[] }

const MS_30D = 30 * 24 * 3600 * 1000;
function sharpe(ret: Float64Array, from: number, to: number): number { let s = 0, sq = 0, n = 0; for (let i = Math.max(0, from); i <= to && i < ret.length; i++) { s += ret[i]; sq += ret[i] * ret[i]; n++; } if (n < 2) return 0; const m = s / n, sd = Math.sqrt(Math.max(0, sq / n - m * m)); return sd > 1e-12 ? (m / sd) * Math.sqrt(365) : 0; }

/** Purged WF re-selecting {zWin, thresh} per window on the IV-timing stream. */
export function walkForwardIv(doc: IvSleeveDoc, S: IvDaily, cfg: { trainMonths?: number; stepMonths?: number; tuneTrials?: number; endTs?: number } = {}): IvWfReport {
  const trainMs = (cfg.trainMonths ?? 12) * MS_30D, stepMs = (cfg.stepMonths ?? 4) * MS_30D;
  const endTs = cfg.endTs ?? S.t[S.t.length - 1], startTs = S.t[0];
  const idxOf = (ts: number): number => { let lo = 0, hi = S.t.length - 1, r = S.t.length; while (lo <= hi) { const m = (lo + hi) >> 1; if (S.t[m] >= ts) { r = m; hi = m - 1; } else lo = m + 1; } return r; };
  const zWins = [60, 120, 250], threshs = [0, 0.5, 1.0];
  const purge = doc.rvWin + 5;
  const pooled: number[] = [], pooledT: number[] = []; const byWin: Record<string, number>[] = [];
  let testStart = startTs + trainMs;
  while (testStart + stepMs <= endTs + stepMs && idxOf(testStart) < S.t.length) {
    const trainStartI = idxOf(testStart - trainMs), trainEndI = idxOf(testStart) - 1 - purge;
    const testStartI = idxOf(testStart), testEndI = Math.min(S.t.length - 1, idxOf(Math.min(testStart + stepMs, endTs + stepMs)) - 1);
    if (testEndI <= testStartI + 5 || trainEndI - trainStartI < 120) { testStart += stepMs; continue; }
    let best: { p: Record<string, number>; sh: number } | null = null;
    for (const zw of zWins) for (const th of threshs) {
      const bt = backtestIv(doc, S, { zWin: zw, thresh: th }, { startI: trainStartI, endI: trainEndI });
      const sh = sharpe(bt.ret, trainStartI + 1, trainEndI);
      if (!best || sh > best.sh) best = { p: { zWin: zw, thresh: th }, sh };
    }
    const bt = backtestIv(doc, S, best!.p, { startI: trainStartI, endI: testEndI });
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

void PPY;
