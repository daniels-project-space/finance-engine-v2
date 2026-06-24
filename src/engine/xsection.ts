// CROSS-SECTIONAL strategy module (productionized from the Step-3 spike).
//
// A cross-sectional sleeve ranks the WHOLE universe each rebalance on a per-coin
// `rankSignal` (any numeric Expr over the existing grammar — trailing-return /
// CTREND for TREND, funding/fundmom for CARRY), goes LONG the top-K equal-weight
// (LONG-FLAT: weights >= 0, NEVER short — crypto shorts get liquidated), vol-
// targets the book, holds `rebalEvery` bars, and charges realistic costs
// (fee+slip on turnover, funding per bar). Output is ONE universe-wide return
// stream — so it is inherently cross-symbol and skips the per-symbol S4 gate.
//
// NO LOOK-AHEAD: rankSignal at bar i is computed from each coin's compiled
// inputs over [0..i]; the weight decided at i earns bar i+1's return.

import { evalNum, toArrays, type CompiledInputs } from "./compile";
import { DEFAULT_FEE_BPS, SLIP_BPS, PPY, type Bars, type Expr, type ParamSpec, type RiskSpec } from "./types";

const FEE = DEFAULT_FEE_BPS;
const slipOf = (sym: string) => SLIP_BPS[sym] ?? 5; // mid-caps default 5bps

export interface XSectionDoc {
  name: string;
  kind: "xsection";
  hypothesis: string;
  tf?: "1h" | "4h" | "1d";
  /** per-coin numeric score; the universe is ranked by this each rebalance */
  rankSignal: Expr;
  /** longest trailing window any signal needs (for warmup + the WF purge) */
  lookback: number;
  /** number of top-ranked coins to hold long (equal weight) */
  topK: number;
  /** rebalance cadence in bars */
  rebalEvery: number;
  /** always "long-flat" — encoded for clarity + a guard */
  side: "long-flat";
  params: Record<string, ParamSpec>;
  risk: RiskSpec;
}

export function isXSection(doc: unknown): doc is XSectionDoc {
  return !!doc && typeof doc === "object" && (doc as { kind?: string }).kind === "xsection";
}

/** One universe symbol prepared for cross-sectional backtest. */
export interface XUniverseSymbol { symbol: string; bars: Bars; inp: CompiledInputs; fundingAtBar: Float64Array }

/** Align the universe on its COMMON timestamp set and pre-compile each coin's
 *  inputs once (hot path: signals are re-evaluated per param trial). */
export interface XAligned {
  t: number[];
  symbols: string[];
  close: number[][];
  ret: number[][];           // per-coin simple bar returns
  funding: number[][];       // per-coin per-bar funding (long pays positive)
  inp: CompiledInputs[];     // per-coin compiled inputs, RE-INDEXED to the common grid
}

function fundingPerBar(bars: Bars): Map<number, number> {
  const m = new Map<number, number>();
  if (bars.fundingT && bars.fundingR) {
    // attach each funding stamp to the first bar whose open >= the stamp (same
    // rule as the per-symbol backtester); accumulate if multiple in one bar.
    let bi = 0;
    for (let fi = 0; fi < bars.fundingT.length; fi++) {
      const ft = bars.fundingT[fi];
      while (bi < bars.t.length - 1 && bars.t[bi] < ft) bi++;
      if (bars.t[bi] >= ft) m.set(bars.t[bi], (m.get(bars.t[bi]) ?? 0) + bars.fundingR[fi]);
    }
  }
  return m;
}

/** Build the aligned universe. Each coin's compiled inputs are sliced to the
 *  common-timestamp grid so evalNum returns a vector indexed like `t`. */
export function alignUniverse(barsList: { symbol: string; bars: Bars }[]): XAligned {
  if (barsList.length === 0) return { t: [], symbols: [], close: [], ret: [], funding: [], inp: [] };
  const sets = barsList.map((b) => new Set(b.bars.t));
  const base = barsList[0].bars.t.filter((t) => sets.every((s) => s.has(t)));
  const baseIdx = new Map<number, number>(); base.forEach((t, i) => baseIdx.set(t, i));
  const close: number[][] = [], ret: number[][] = [], funding: number[][] = [], inp: CompiledInputs[] = [];
  for (const { bars } of barsList) {
    const im = new Map<number, number>(); bars.t.forEach((t, i) => im.set(t, i));
    const fmap = fundingPerBar(bars);
    // full-series compiled inputs (indicators warm on full history), then re-index
    // every field to the common-timestamp grid so evalNum(score) lines up with `t`.
    const fullInp = toArrays(bars);
    const c: number[] = [], f: number[] = [];
    const n = base.length;
    const reIdx = base.map((t) => im.get(t)!);
    const pick = (src: Float64Array): Float64Array => { const out = new Float64Array(n); for (let bi = 0; bi < n; bi++) out[bi] = src[reIdx[bi]]; return out; };
    for (let bi = 0; bi < n; bi++) { c.push(bars.c[reIdx[bi]]); f.push(fmap.get(base[bi]) ?? 0); }
    close.push(c);
    const rr = new Array(n).fill(0); for (let i = 1; i < n; i++) rr[i] = c[i - 1] > 0 ? c[i] / c[i - 1] - 1 : 0;
    ret.push(rr); funding.push(f);
    inp.push({
      o: pick(fullInp.o), h: pick(fullInp.h), l: pick(fullInp.l), c: pick(fullInp.c), v: pick(fullInp.v),
      f: pick(fullInp.f), fundroc: pick(fullInp.fundroc), fundzscore: pick(fullInp.fundzscore),
      fundaccel: pick(fullInp.fundaccel), fundmom: pick(fullInp.fundmom), basis: pick(fullInp.basis),
      oi: pick(fullInp.oi), lsr: pick(fullInp.lsr), hour: pick(fullInp.hour), dow: pick(fullInp.dow),
      mvrv: pick(fullInp.mvrv), activeaddr: pick(fullInp.activeaddr), txcnt: pick(fullInp.txcnt),
      nvt: pick(fullInp.nvt), exnetflow: pick(fullInp.exnetflow), stablesupply: pick(fullInp.stablesupply),
    });
  }
  return { t: base, symbols: barsList.map((b) => b.symbol), close, ret, funding, inp };
}

export interface XBacktestResult { ret: Float64Array; t: number[]; turnover: number; nRebal: number }

/**
 * Backtest a cross-sectional long-flat sleeve over an aligned universe and a bar
 * range [from,to]. Ranks by `rankSignal` (evaluated per coin, info <= i), longs
 * the top-K equal-weight, vol-targets to risk.volTargetAnnual (leverage capped at
 * risk.maxLeverage), charges fee+slip turnover + funding. LONG-FLAT guard: weights
 * are always >= 0.
 */
export function backtestXSection(
  doc: XSectionDoc, A: XAligned, params: Record<string, number>, ppy: number,
  range?: { startI?: number; endI?: number },
): XBacktestResult {
  const S = A.symbols.length, n = A.t.length;
  const startI = Math.max(doc.lookback + 1, range?.startI ?? doc.lookback + 1);
  const endI = Math.min(n - 1, range?.endI ?? n - 1);
  const topK = Math.max(1, Math.min(S, Math.round(params.topK ?? doc.topK)));
  const rebal = Math.max(1, Math.round(params.rebalEvery ?? doc.rebalEvery));

  // per-coin rank score series (evalNum over each coin's compiled inputs)
  const scores: Float64Array[] = A.inp.map((inp) => evalNum(doc.rankSignal, inp, params, new Map()));

  const w = Array.from({ length: S }, () => new Float64Array(n));
  let curW = new Array(S).fill(0);
  let rebalCount = 0;
  for (let i = startI; i <= endI; i++) {
    if ((i - startI) % rebal === 0) {
      // rank coins by score at bar i (info <= i); pick top-K finite scores
      const order = [];
      for (let k = 0; k < S; k++) { const sc = scores[k][i]; if (Number.isFinite(sc)) order.push([sc, k] as [number, number]); }
      order.sort((a, b) => b[0] - a[0]);
      curW = new Array(S).fill(0);
      const picks = order.slice(0, topK);
      for (const [, k] of picks) curW[k] = picks.length ? 1 / picks.length : 0; // LONG-FLAT equal weight
      rebalCount++;
    }
    for (let k = 0; k < S; k++) w[k][i] = curW[k];
  }

  // realize net returns at unit gross exposure
  const raw = new Float64Array(n);
  let turnoverSum = 0;
  for (let i = startI + 1; i <= endI; i++) {
    let gross = 0, cost = 0, fund = 0;
    for (let k = 0; k < S; k++) {
      const wk = w[k][i - 1];
      gross += wk * A.ret[k][i];
      const dw = Math.abs(w[k][i - 1] - (w[k][i - 2] ?? 0));
      cost += dw * (FEE + slipOf(A.symbols[k])) / 10_000;
      fund += wk * A.funding[k][i];
      turnoverSum += dw;
    }
    raw[i] = gross - cost - fund;
  }

  // book-level vol target (cap leverage at risk.maxLeverage)
  let s = 0, sq = 0, cnt = 0;
  for (let i = startI + 1; i <= endI; i++) { s += raw[i]; sq += raw[i] * raw[i]; cnt++; }
  const mean = s / Math.max(1, cnt);
  const sd = Math.sqrt(Math.max(0, sq / Math.max(1, cnt) - mean * mean));
  const annVol = sd * Math.sqrt(ppy);
  const lev = annVol > 1e-9 ? Math.min(doc.risk.maxLeverage ?? 3, (doc.risk.volTargetAnnual ?? 0.4) / annVol) : 1;
  const ret = new Float64Array(n);
  for (let i = startI + 1; i <= endI; i++) ret[i] = Math.max(-0.95, raw[i] * lev);

  return { ret, t: A.t, turnover: turnoverSum, nRebal: rebalCount };
}

// --------------------------------------------------------- purged walk-forward
export interface XWfReport {
  pooledRet: Float64Array; pooledT: Float64Array;
  pooledSharpe: number; pctPositive: number; worstWindowRet: number; pooledMaxDD: number;
  windows: number; totalTrades: number;
  bestParamsByWindow: Record<string, number>[];
}

const MS_30D = 30 * 24 * 3600 * 1000;

/** Purged, re-selecting walk-forward on the cross-sectional stream. Each window
 *  re-picks {topK, rebalEvery} (and any rankSignal params) on the trailing train
 *  span (purged from the test fold), then trades OOS. Honest — no test info in
 *  selection. Mirrors the per-symbol walk-forward discipline. */
export function walkForwardXSection(
  doc: XSectionDoc, A: XAligned, ppy: number,
  cfg: { trainMonths?: number; stepMonths?: number; tuneTrials?: number; endTs?: number; seed?: number } = {},
): XWfReport {
  const trainMs = (cfg.trainMonths ?? 12) * MS_30D;
  const stepMs = (cfg.stepMonths ?? 1) * MS_30D;
  const endTs = cfg.endTs ?? A.t[A.t.length - 1];
  const startTs = A.t[0];
  const idxOf = (ts: number): number => { let lo = 0, hi = A.t.length - 1, r = A.t.length; while (lo <= hi) { const m = (lo + hi) >> 1; if (A.t[m] >= ts) { r = m; hi = m - 1; } else lo = m + 1; } return r; };
  const purge = doc.lookback + 2;

  const trials = paramTrials(doc, cfg.tuneTrials ?? 24, cfg.seed ?? 7);

  const pooled: number[] = [], pooledTs: number[] = [];
  const bestByWin: Record<string, number>[] = [];
  let testStart = startTs + trainMs;
  while (testStart + stepMs <= endTs) {
    const trainStartI = idxOf(testStart - trainMs);
    const trainEndI = idxOf(testStart) - 1 - purge;
    const testStartI = idxOf(testStart);
    const testEndI = idxOf(Math.min(testStart + stepMs, endTs)) - 1;
    const minTrain = Math.max(100, Math.floor(0.4 * (cfg.trainMonths ?? 12) * (ppy / 12)));
    if (testEndI <= testStartI + 8 || trainEndI - trainStartI < minTrain) { testStart += stepMs; continue; }

    // select best params on the train window by in-sample Sharpe
    let best: { p: Record<string, number>; sh: number } | null = null;
    for (const p of trials) {
      const bt = backtestXSection(doc, A, p, ppy, { startI: trainStartI, endI: trainEndI });
      const sh = sharpeOf(bt.ret, trainStartI + 1, trainEndI, ppy);
      if (!best || sh > best.sh) best = { p, sh };
    }
    // trade OOS with the selected params (warm from train start)
    const bt = backtestXSection(doc, A, best!.p, ppy, { startI: trainStartI, endI: testEndI });
    for (let i = testStartI; i <= testEndI; i++) { pooled.push(bt.ret[i]); pooledTs.push(A.t[i]); }
    bestByWin.push(best!.p);
    testStart += stepMs;
  }

  const pooledRet = Float64Array.from(pooled);
  const sh = sharpeOf(pooledRet, 0, pooledRet.length - 1, ppy);
  // monthly buckets for positivity + worst window
  const perMonth = Math.max(1, Math.floor(ppy / 12));
  let pos = 0, mo = 0, worst = 0;
  for (let i = 0; i < pooled.length; i += perMonth) {
    let g = 1; for (let j = i; j < Math.min(i + perMonth, pooled.length); j++) g *= 1 + pooled[j];
    const r = g - 1; if (r > 0) pos++; if (r < worst) worst = r; mo++;
  }
  let eq = 1, peak = 1, maxDD = 0;
  for (const r of pooled) { eq *= 1 + r; if (eq > peak) peak = eq; const d = eq / peak - 1; if (d < maxDD) maxDD = d; }
  return {
    pooledRet, pooledT: Float64Array.from(pooledTs),
    pooledSharpe: sh, pctPositive: mo ? pos / mo : 0, worstWindowRet: worst, pooledMaxDD: maxDD,
    windows: bestByWin.length, totalTrades: 0, bestParamsByWindow: bestByWin,
  };
}

function sharpeOf(ret: Float64Array, from: number, to: number, ppy: number): number {
  let s = 0, sq = 0, n = 0;
  for (let i = Math.max(0, from); i <= to && i < ret.length; i++) { s += ret[i]; sq += ret[i] * ret[i]; n++; }
  if (n < 2) return 0;
  const m = s / n, sd = Math.sqrt(Math.max(0, sq / n - m * m));
  return sd > 1e-12 ? (m / sd) * Math.sqrt(ppy) : 0;
}

/** Deterministic param grid for {topK, rebalEvery} + any declared rankSignal params. */
function paramTrials(doc: XSectionDoc, n: number, seed: number): Record<string, number>[] {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out: Record<string, number>[] = [{ ...defaults(doc) }];
  const keys = Object.keys(doc.params ?? {});
  for (let i = 1; i < n; i++) {
    const p: Record<string, number> = { ...defaults(doc) };
    p.topK = Math.max(2, Math.min(doc.topK * 2, Math.round(2 + rnd() * 8)));
    p.rebalEvery = Math.max(1, Math.round(1 + rnd() * 12));
    for (const k of keys) { const sp = doc.params[k]; let v = sp.min + (sp.max - sp.min) * rnd(); if (sp.int) v = Math.round(v); p[k] = v; }
    out.push(p);
  }
  return out;
}
function defaults(doc: XSectionDoc): Record<string, number> {
  const p: Record<string, number> = { topK: doc.topK, rebalEvery: doc.rebalEvery };
  for (const [k, sp] of Object.entries(doc.params ?? {})) p[k] = sp.default;
  return p;
}
