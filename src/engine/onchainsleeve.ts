// ON-CHAIN TIMING sleeve — captures the A/B-test winner (BTC MVRV-valuation
// timing, OOS 0.96, the strongest single non-momentum sleeve found). Mirrors the
// IV-sleeve pattern: long-flat single-coin (BTC/ETH) perp timing on an on-chain
// VALUATION regime (MVRV / NVT), long when the asset is CHEAP (z-score low).
//
// Slow valuation signals trade only a few times in 5y, so the per-symbol gauntlet
// trade-count floor rejects them — this dedicated timing path (like IV) captures
// the edge. Point-in-time (the on-chain series is already 1-day-lagged + forward-
// filled onto bars). LONG-FLAT (weight in {0,1}), realistic costs. BTC/ETH only.

import { type Bars } from "./types";

export type OcSignal = "mvrv_cheap" | "nvt_cheap" | "mvrv_rich" | "nvt_rich";

export interface OcSleeveDoc {
  name: string;
  kind: "onchainsleeve";
  hypothesis: string;
  symbol: string;          // "BTC/USDT" | "ETH/USDT"
  tf: "1d";                // on-chain is daily
  signal: OcSignal;
  zWin: number;            // trailing window for the on-chain z-score
  thresh: number;          // z-score threshold to be long
  params: Record<string, { min: number; max: number; default: number; int?: boolean }>;
  risk: { volTargetAnnual: number; maxLeverage: number };
}

export function isOcSleeve(doc: unknown): doc is OcSleeveDoc {
  return !!doc && typeof doc === "object" && (doc as { kind?: string }).kind === "onchainsleeve";
}

const FEE_BPS = 5;
const SLIP_BPS_D: Record<string, number> = { "BTC/USDT": 1.5, "ETH/USDT": 2 };

/** Daily-aligned inputs: perp daily returns + the on-chain feature + funding. */
export interface OcDaily { t: number[]; ret: number[]; feat: number[]; funding: number[] }

/** Build the daily series from 1d perp bars (with on-chain attached) for a signal.
 *  Point-in-time: the oc* arrays are already forward-filled + 1-day-lagged. */
export function buildOcDaily(bars: Bars, signal: OcSignal): OcDaily {
  const t: number[] = [], ret: number[] = [], feat: number[] = [], fund: number[] = [];
  const dr: number[] = [0];
  for (let i = 1; i < bars.c.length; i++) dr.push(bars.c[i - 1] > 0 ? bars.c[i] / bars.c[i - 1] - 1 : 0);
  const fmap = new Map<number, number>();
  if (bars.fundingT && bars.fundingR) for (let i = 0; i < bars.fundingT.length; i++) { const day = Math.floor(bars.fundingT[i] / 86400000) * 86400000; fmap.set(day, (fmap.get(day) ?? 0) + bars.fundingR[i]); }
  const src = signal.startsWith("mvrv") ? bars.ocMvrv : bars.ocNvt;
  for (let i = 0; i < bars.t.length; i++) {
    const v = src?.[i];
    if (v === undefined || v === 0) continue; // skip bars with no on-chain coverage
    const day = Math.floor(bars.t[i] / 86400000) * 86400000;
    t.push(bars.t[i]); ret.push(dr[i]); feat.push(v); fund.push(fmap.get(day) ?? 0);
  }
  return { t, ret, feat, funding: fund };
}

/** Trailing z-score of arr at i over win, using ONLY bars < i (point-in-time). */
function zPast(arr: number[], i: number, win: number): number {
  const lo = Math.max(0, i - win); let s = 0, sq = 0, n = 0;
  for (let k = lo; k < i; k++) { s += arr[k]; sq += arr[k] * arr[k]; n++; }
  if (n < 20) return 0;
  const m = s / n, sd = Math.sqrt(Math.max(1e-12, sq / n - m * m));
  return (arr[i] - m) / sd;
}

export interface OcBacktest { ret: Float64Array; t: number[]; exposure: number; flips: number }

/** Long-flat on-chain-timing backtest. Weight decided at close of day i (info<=i)
 *  earns day i+1's return. "cheap" => long when z < -thresh (valuation low);
 *  "rich" => long when z > thresh. Charges fee+slip on flips + funding while long. */
export function backtestOc(doc: OcSleeveDoc, S: OcDaily, params: Record<string, number>, range?: { startI?: number; endI?: number }): OcBacktest {
  const n = S.t.length;
  const zWin = Math.max(20, Math.round(params.zWin ?? doc.zWin));
  const thresh = params.thresh ?? doc.thresh;
  const slip = SLIP_BPS_D[doc.symbol] ?? 2;
  const cheap = doc.signal.endsWith("cheap");
  const warm = zWin + 2;
  const startI = Math.max(warm, range?.startI ?? warm);
  const endI = Math.min(n - 1, range?.endI ?? n - 1);
  const w = new Float64Array(n);
  for (let i = startI; i <= endI; i++) {
    const z = zPast(S.feat, i, zWin);
    w[i] = (cheap ? z < -thresh : z > thresh) ? 1 : 0;
  }
  const out = new Float64Array(n);
  let exp = 0, flips = 0;
  for (let i = startI + 1; i <= endI; i++) {
    const wk = w[i - 1];
    const dw = Math.abs(w[i - 1] - (w[i - 2] ?? 0));
    if (dw > 0) flips++;
    out[i] = wk * S.ret[i] - dw * (FEE_BPS + slip) / 1e4 - wk * S.funding[i];
    exp += wk;
  }
  let s = 0, sq = 0, c = 0; for (let i = startI + 1; i <= endI; i++) { s += out[i]; sq += out[i] * out[i]; c++; }
  const sd = Math.sqrt(Math.max(0, sq / Math.max(1, c) - (s / Math.max(1, c)) ** 2));
  const annVol = sd * Math.sqrt(365);
  const lev = annVol > 1e-9 ? Math.min(doc.risk.maxLeverage, doc.risk.volTargetAnnual / annVol) : 1;
  const scaled = new Float64Array(n);
  for (let i = startI + 1; i <= endI; i++) scaled[i] = Math.max(-0.95, out[i] * lev);
  return { ret: scaled, t: S.t, exposure: exp / Math.max(1, endI - startI), flips };
}

export interface OcWfReport { pooledRet: Float64Array; pooledT: Float64Array; pooledSharpe: number; pctPositive: number; pooledMaxDD: number; worstWindowRet: number; windows: number; bestParamsByWindow: Record<string, number>[] }

const MS_30D = 30 * 24 * 3600 * 1000;
function sharpe(ret: Float64Array, from: number, to: number): number { let s = 0, sq = 0, n = 0; for (let i = Math.max(0, from); i <= to && i < ret.length; i++) { s += ret[i]; sq += ret[i] * ret[i]; n++; } if (n < 2) return 0; const m = s / n, sd = Math.sqrt(Math.max(0, sq / n - m * m)); return sd > 1e-12 ? (m / sd) * Math.sqrt(365) : 0; }

/** Purged WF re-selecting {zWin, thresh} per window on the on-chain-timing stream. */
export function walkForwardOc(doc: OcSleeveDoc, S: OcDaily, cfg: { trainMonths?: number; stepMonths?: number; endTs?: number } = {}): OcWfReport {
  const trainMs = (cfg.trainMonths ?? 12) * MS_30D, stepMs = (cfg.stepMonths ?? 4) * MS_30D;
  const endTs = cfg.endTs ?? S.t[S.t.length - 1], startTs = S.t[0];
  const idxOf = (ts: number): number => { let lo = 0, hi = S.t.length - 1, r = S.t.length; while (lo <= hi) { const m = (lo + hi) >> 1; if (S.t[m] >= ts) { r = m; hi = m - 1; } else lo = m + 1; } return r; };
  const zWins = [60, 120, 250], threshs = [0, 0.5, 1.0];
  const purge = 20;
  const pooled: number[] = [], pooledT: number[] = []; const byWin: Record<string, number>[] = [];
  let testStart = startTs + trainMs;
  while (testStart + stepMs <= endTs + stepMs && idxOf(testStart) < S.t.length) {
    const trainStartI = idxOf(testStart - trainMs), trainEndI = idxOf(testStart) - 1 - purge;
    const testStartI = idxOf(testStart), testEndI = Math.min(S.t.length - 1, idxOf(Math.min(testStart + stepMs, endTs + stepMs)) - 1);
    if (testEndI <= testStartI + 5 || trainEndI - trainStartI < 120) { testStart += stepMs; continue; }
    let best: { p: Record<string, number>; sh: number } | null = null;
    for (const zw of zWins) for (const th of threshs) {
      const bt = backtestOc(doc, S, { zWin: zw, thresh: th }, { startI: trainStartI, endI: trainEndI });
      const sh = sharpe(bt.ret, trainStartI + 1, trainEndI);
      if (!best || sh > best.sh) best = { p: { zWin: zw, thresh: th }, sh };
    }
    const bt = backtestOc(doc, S, best!.p, { startI: trainStartI, endI: testEndI });
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
