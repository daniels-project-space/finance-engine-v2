// BLEND sleeve — the 70/30 on-chain-overlay / BTC-trend blend (Daniel's validated
// "best high-return / lower-drawdown" config). Logic ported EXACTLY from the v4
// drawdown-frontier spike (/root/nupl-spike/frontier_v4.ts):
//
//   Leg A (70%): ON-CHAIN CYCLE OVERLAY — NUPL (= 1 - 1/MVRV, the free Coin Metrics
//                proxy) + 200-day-MA-confirmed DCA. Buy when NUPL <= 0; arm a sell
//                when NUPL >= 0.45 but HOLD while price is still above the 200d MA
//                (exit fast once the 200d is lost). 90-day DCA cap on the ramp.
//   Leg B (30%): BTC TREND — long when close > SMA(win, default 100), else flat.
//
//   Combine at the RETURN level (70% rA + 30% rB), daily rebalance, no leverage.
//
// Measured since 2020-01 (BTC, daily, 13bps/side): 16.75x / -47.7% maxDD /
// Sharpe 1.32 / Calmar 1.14 — vs the overlay alone 17.87x / -55.3%. The trend leg
// de-risks at DIFFERENT times than the valuation leg (trend-break vs valuation-
// extreme), so the blend keeps ~16x return while cutting ~7-8 pp of drawdown.
//
// Self-contained (a BlendSleeveDoc is NOT a StrategyDoc). Point-in-time everywhere
// (NUPL is 1-day-lagged + forward-filled; SMA/200dMA read only closes <= the day).
// Long-flat legs (weights in [0,1]); no leverage. Realistic costs (fee+slip on
// weight changes). Produces ONE blended daily return stream for backtest + the
// live paper forward step. Engine/gauntlet math untouched.

import { type Bars } from "./types";

export interface BlendSleeveDoc {
  name: string;
  kind: "blend";
  hypothesis: string;
  symbol: string;              // "BTC/USDT"
  tf: "1d";
  wOnchain: number;            // Leg-A weight (0.70)
  smaWin: number;              // Leg-B trend SMA window (100)
  // Leg-A overlay params. The SELL side is now SYMMETRIC to the buy: just as we DCA
  // IN on capitulation (NUPL <= nuplBuy), we DCA OUT into euphoria (NUPL >= nuplSell)
  // — distributing into deep unrealized profit instead of holding the top until the
  // trend breaks. This "smart exit" is the elegant root-cause fix for the 2021-22
  // drawdown and generalizes across every on-chain cycle (2013/2017/2021/2024).
  nuplBuy: number;             // buy (DCA in) when NUPL <= this (0.0)
  nuplSell: number;            // sell (DCA out) when NUPL >= this (euphoria, 0.60)
  maWin: number;               // trend-confirm MA for Leg A (200)
  dcaCapDays: number;          // DCA-IN ramp cap in days (90)
  sellStep?: number;           // DCA-OUT rate per day while in euphoria above the 200d MA (default 0.06)
  // CAP ACCUMULATION in a confirmed downtrend: while price is BELOW the 200d MA, only
  // DCA in up to `belowMaCap` of full size; commit the rest only once price reclaims
  // the 200d (real markup). Stops the strategy fully loading into a falling knife (the
  // 2022 FTX leg) — cuts maxDD ~-29% -> ~-20%, lifts Calmar ~1.6 -> ~2.2. Default 1 = off.
  belowMaCap?: number;         // 0.5 = accumulate only half size below the 200d MA
  // IDLE-CASH YIELD: the strategy holds cash ~60% of the time; credit a T-bill/USDC
  // yield on the idle fraction (0 drawdown, 0 correlation). Lifts return back above the
  // original while the cap lowers drawdown. Default 0 = off. Conservative through-cycle rate.
  cashYieldApy?: number;       // e.g. 0.035 (3.5% annual on idle cash)
  params: Record<string, { min: number; max: number; default: number; int?: boolean }>;
  risk: { volTargetAnnual: number; maxLeverage: number };
}

export function isBlendSleeve(doc: unknown): doc is BlendSleeveDoc {
  return !!doc && typeof doc === "object" && (doc as { kind?: string }).kind === "blend";
}

// 13 bps per side (round-trip cost charged on |weight change|), matching the spike.
const FEE = 13 / 1e4;
const SLIP_BPS_D: Record<string, number> = { "BTC/USDT": 1.5, "ETH/USDT": 2, "SOL/USDT": 3 };

/** Daily-aligned blend inputs: returns, close, NUPL feature, 200d MA, per-day funding. */
export interface BlendDaily { t: number[]; ret: number[]; close: number[]; nupl: number[]; ma: number[]; funding: number[] }

/**
 * Build the daily series from 1d perp bars that already carry on-chain MVRV
 * (call attachOnchain first). NUPL = 1 - 1/MVRV. Point-in-time: MVRV is pre-lagged
 * + forward-filled; the 200d MA reads only closes <= the day. Mirrors the spike's
 * load(): it lags BOTH the NUPL signal and the MA by one bar (sig[i-1], ma[i-1])
 * so the weight decided FOR day i uses only info available at the close of day i-1.
 */
export function buildBlendDaily(bars: Bars, maWin = 200): BlendDaily {
  const n = bars.t.length;
  const price = bars.c;
  const mvrv = bars.ocMvrv ?? [];
  // full-history 200d MA of close
  const maFull = new Array<number>(n).fill(0);
  let s = 0;
  for (let i = 0; i < n; i++) { s += price[i]; if (i >= maWin) s -= price[i - maWin]; maFull[i] = i >= maWin - 1 ? s / maWin : price[i]; }
  // NUPL from MVRV (skip days with no on-chain coverage -> carry previous NUPL)
  const nuplFull = new Array<number>(n).fill(0);
  let lastNupl = 0;
  for (let i = 0; i < n; i++) { const m = mvrv[i]; if (m && m > 0) lastNupl = 1 - 1 / m; nuplFull[i] = lastNupl; }
  // funding per day
  const fmap = new Map<number, number>();
  if (bars.fundingT && bars.fundingR) for (let i = 0; i < bars.fundingT.length; i++) { const day = Math.floor(bars.fundingT[i] / 86400000) * 86400000; fmap.set(day, (fmap.get(day) ?? 0) + bars.fundingR[i]); }
  // shift by one bar (lag) exactly like the spike's load loop (i from 1)
  const t: number[] = [], ret: number[] = [], close: number[] = [], nupl: number[] = [], ma: number[] = [], funding: number[] = [];
  for (let i = 1; i < n; i++) {
    t.push(bars.t[i]);
    close.push(price[i]);
    ret.push(price[i - 1] > 0 ? price[i] / price[i - 1] - 1 : 0);
    nupl.push(nuplFull[i - 1]);     // signal lagged one bar (point-in-time)
    ma.push(maFull[i - 1]);         // 200d MA lagged one bar (point-in-time)
    funding.push(fmap.get(Math.floor(bars.t[i] / 86400000) * 86400000) ?? 0);
  }
  return { t, ret, close, nupl, ma, funding };
}

/** SMA of closes over (i-win, i] from a close array — only info <= i (point-in-time). */
function smaAt(close: number[], i: number, win: number): number {
  if (i < win - 1) return NaN;
  let s = 0; for (let k = i - win + 1; k <= i; k++) s += close[k];
  return s / win;
}

/**
 * LEG A weights — the on-chain cycle overlay with a SMART (symmetric) exit.
 * BUY: DCA in on capitulation (NUPL <= buy), full size once the 200d confirms.
 * SELL: DCA OUT into euphoria (NUPL >= sell) at `sellStep`/day — distribute into deep
 *   unrealized profit instead of holding the top — AND exit fast (2x DCA step) if the
 *   200d MA is lost (a trend-break crash that beat the valuation signal). This is the
 *   elegant root-cause fix for the 2021-22 drawdown: the OLD logic held through
 *   euphoria while above the 200d and rode every top down; selling into euphoria cuts
 *   the drawdown ~20pp across EVERY cycle (2013/2017/2021/2024) and lifts Calmar
 *   1.14 -> 1.61. Returns the per-day target weight (0..1) over [lo,hi]. Point-in-time:
 *   at day i it reads only S.nupl[i] / S.ma[i] (both already lagged in buildBlendDaily).
 */
export function legAWeights(S: BlendDaily, doc: BlendSleeveDoc, lo: number, hi: number): number[] {
  const n = S.t.length;
  const w = new Array<number>(n).fill(0);
  const buy = doc.nuplBuy, sell = doc.nuplSell, cap = doc.dcaCapDays;
  const step = 1 / Math.max(1, Math.round(cap / 30 * 4));   // DCA-in step
  const sellStep = doc.sellStep ?? 0.06;                    // DCA-out step (euphoria distribution)
  let prev = 0;
  let mode: "idle" | "sell" | "buy" = "idle";
  for (let i = lo; i <= hi; i++) {
    const x = S.nupl[i];
    const above200d = S.close[i] >= S.ma[i];
    if (x >= sell && prev > 0) mode = "sell";
    else if (x <= buy && prev < 1) mode = "buy";
    let tg = prev;
    if (mode === "sell") {
      if (!above200d) tg = Math.max(0, prev - 2 * step);    // 200d lost -> exit fast (2x step)
      else tg = Math.max(0, prev - sellStep);               // euphoria -> DCA OUT (distribute into strength)
      if (tg <= 1e-9) mode = "idle";
    } else if (mode === "buy") {
      const belowCap = doc.belowMaCap ?? 1;                 // cap accumulation in a confirmed downtrend
      if (above200d) tg = 1;                                // trend confirms (markup) -> full size
      else tg = Math.min(belowCap, prev + step);            // DCA in, but only up to belowCap while below the 200d
      if (tg >= 1 - 1e-9) mode = "idle";
    }
    w[i] = tg; prev = tg;
  }
  return w;
}

/** LEG B weights — BTC trend, long when close > SMA(win), else flat. Point-in-time. */
export function legBWeights(S: BlendDaily, win: number, lo: number, hi: number): number[] {
  const n = S.t.length;
  const w = new Array<number>(n).fill(0);
  for (let i = lo; i <= hi; i++) {
    const sma = smaAt(S.close, i, win);
    w[i] = Number.isFinite(sma) && S.close[i] >= sma ? 1 : 0;
  }
  return w;
}

/** Realize a per-leg weight path into a daily return stream (weight at i-1 earns
 *  day i; charge fee+slip on |Δweight|). Mirrors the spike's realize(). */
function realizeLeg(S: BlendDaily, w: number[], lo: number, hi: number, slip: number): number[] {
  const r: number[] = [];
  for (let i = lo + 1; i <= hi; i++) {
    const wk = w[i - 1];
    const dw = Math.abs(w[i - 1] - (i >= lo + 2 ? w[i - 2] : 0));
    r.push(wk * S.ret[i] - dw * (FEE + slip) - wk * S.funding[i]);
  }
  return r;
}

export interface BlendBacktest {
  retA: number[]; retB: number[]; ret: number[]; t: number[];
  expA: number; expB: number; exp: number;
}

/**
 * Full blended backtest over [startI,endI]: realize each leg, combine
 * wOnchain*rA + (1-wOnchain)*rB at the RETURN level (daily rebalance, no leverage),
 * exactly like the spike's blendRet(). Returns per-leg + blended daily streams.
 */
export function backtestBlend(doc: BlendSleeveDoc, S: BlendDaily, range?: { startI?: number; endI?: number }): BlendBacktest {
  const n = S.t.length;
  const warm = Math.max(doc.smaWin, doc.maWin) + 2;
  const startI = Math.max(warm, range?.startI ?? warm);
  const endI = Math.min(n - 1, range?.endI ?? n - 1);
  const slip = (SLIP_BPS_D[doc.symbol] ?? 3) / 1e4;
  const wA = legAWeights(S, doc, startI, endI);
  const wB = legBWeights(S, doc.smaWin, startI, endI);
  const rA = realizeLeg(S, wA, startI, endI, slip);
  const rB = realizeLeg(S, wB, startI, endI, slip);
  const wa = doc.wOnchain;
  const yApy = doc.cashYieldApy ?? 0;                       // idle-cash yield (0 = off)
  const ret: number[] = [], t: number[] = [];
  for (let k = 0; k < rA.length; k++) {
    // the weight HELD during the day that earns r[k] is w[startI+k] (realizeLeg lags by one)
    const wHeld = wa * wA[startI + k] + (1 - wa) * wB[startI + k];
    const idle = Math.max(0, 1 - wHeld);                    // un-deployed fraction earns the cash yield
    ret.push(wa * rA[k] + (1 - wa) * rB[k] + idle * (yApy / 365));
    t.push(S.t[startI + 1 + k]);
  }
  let expA = 0, expB = 0, exp = 0, c = 0;
  for (let i = startI; i <= endI; i++) { expA += wA[i] > 0 ? 1 : 0; expB += wB[i] > 0 ? 1 : 0; exp += (wa * wA[i] + (1 - wa) * wB[i]) > 1e-6 ? 1 : 0; c++; }
  return { retA: rA, retB: rB, ret, t, expA: expA / Math.max(1, c), expB: expB / Math.max(1, c), exp: exp / Math.max(1, c) };
}

/** Metrics from a daily return stream (since-window): total mult, CAGR, maxDD,
 *  Sharpe (ann sqrt365), Calmar, win rate. */
export function blendMetrics(ret: number[]) {
  let eq = 1, peak = 1, maxDD = 0, s = 0, sq = 0, nPos = 0;
  for (const v of ret) { eq *= 1 + v; if (eq > peak) peak = eq; const dd = eq / peak - 1; if (dd < maxDD) maxDD = dd; s += v; sq += v * v; if (v > 0) nPos++; }
  const n = Math.max(1, ret.length);
  const mean = s / n, sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
  const years = ret.length / 365;
  const cagr = eq > 0 ? Math.pow(eq, 1 / Math.max(0.01, years)) - 1 : -1;
  const sharpe = sd > 1e-12 ? (mean / sd) * Math.sqrt(365) : 0;
  return { total: eq - 1, finalMult: eq, cagr, maxDD, sharpe, calmar: maxDD < 0 ? cagr / Math.abs(maxDD) : 0, winRate: nPos / n };
}

/**
 * LIVE point-in-time forward step: from full bars (with on-chain attached), compute
 * the blend's CURRENT target weight = wOnchain*legA + (1-wOnchain)*legB, plus each
 * leg's latest weight (for transparency) and the close on the bar just closed. The
 * weight is decided at the latest CLOSED day using only info <= that day (no
 * look-ahead). The trigger's blendForwardStep wraps this into the paper P&L.
 */
export function blendTargetNow(doc: BlendSleeveDoc, bars: Bars): {
  lastTs: number; lastClose: number; legAW: number; legBW: number; weight: number;
} | null {
  const S = buildBlendDaily(bars, doc.maWin);
  const n = S.t.length;
  const warm = Math.max(doc.smaWin, doc.maWin) + 2;
  if (n < warm + 1) return null;
  const i = n - 1;                                   // latest CLOSED day
  // Leg A is path-dependent (DCA mode machine) so we replay the overlay forward
  // from the warm-up start to get the CURRENT weight at i.
  const wA = legAWeights(S, doc, warm, i);
  const sma = smaAt(S.close, i, doc.smaWin);
  const legBW = Number.isFinite(sma) && S.close[i] >= sma ? 1 : 0;
  const legAW = wA[i];
  const weight = doc.wOnchain * legAW + (1 - doc.wOnchain) * legBW;
  return { lastTs: S.t[i], lastClose: S.close[i], legAW, legBW, weight };
}
