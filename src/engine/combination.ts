// COMBINATION sleeve — the strategy-COMBINATION / portfolio-composition lane.
//
// The #1 capability gap: the engine could only generate SINGLE strategies, but
// every one of Daniel's wins was a COMBINATION — CORE-4 (chop-trend × 4 coins) and
// the combine (trend + on-chain overlay). This lane GENERATES combined candidates
// the gauntlet judges as ONE unit: the COMBINED out-of-sample return stream is run
// through the SAME validated DSR / bootstrap-CI / floors as any other sleeve. The
// gauntlet/validation math is UNTOUCHED — this is a generation addition only.
//
// Two composition primitives, each a generatable CombinationDoc:
//   - "portfolio": N building-block strategies (chop-trend on different coins),
//     combined with SEARCHED allocation weights (equal / inverse-vol / ERC /
//     concentration). The CORE-4 class.
//   - "overlay":   one base block's signal GATED by another block's regime
//     (base long ONLY when the gate block is also long). The trend×on-chain class.
//
// Each block produces a POINT-IN-TIME OOS return stream (no look-ahead): the block
// signal at close i earns day i+1's return, with realistic costs. The blocks are
// chop-trend specs (close>SMA AND choppiness<thr; the proven mechanism) on liquid
// majors — self-contained, so the lane works from day one without external data.

import { runBacktest } from "./backtest";
import type { Bars, StrategyDoc, Expr } from "./types";

// ----------------------------------------------------------------- block + doc
/** A building block: a chop-trend strategy on one coin (the proven mechanism). */
export interface Block {
  symbol: string;     // "BTC/USDT" | "ETH/USDT" | ...
  smaWin: number;     // trend filter window (days)
  chopThr: number;    // choppiness gate threshold
}

export type CombineMode = "portfolio" | "overlay";
export type AllocScheme = "equal" | "invvol" | "erc" | "concentrate";

export interface CombinationDoc {
  name: string;
  kind: "combination";
  hypothesis: string;
  tf: "1d";
  mode: CombineMode;
  blocks: Block[];          // portfolio: N blocks; overlay: [base, gate]
  alloc: AllocScheme;       // weighting scheme (portfolio only; overlay is base×gate)
  leverage: number;         // book leverage (>=1)
  /** searchable concentration weights for "concentrate" (per block, normalized) */
  concWeights?: number[];
}

export function isCombination(doc: unknown): doc is CombinationDoc {
  return !!doc && typeof doc === "object" && (doc as { kind?: string }).kind === "combination";
}

// ----------------------------------------------------------------- DSL builder
const close: Expr = { op: "price", field: "close" } as Expr;
const Cn = (v: number): Expr => ({ op: "const", value: v } as Expr);
const sma = (p: number): Expr => ({ op: "sma", src: close, period: Cn(p) } as Expr);
/** the chop-trend StrategyDoc for a block — long when close>SMA AND choppiness<thr. */
export function blockDoc(b: Block): StrategyDoc {
  return {
    name: `block_${b.symbol.split("/")[0].toLowerCase()}_sma${b.smaWin}_c${b.chopThr}`, tf: "1d", hypothesis: "chop-gated trend block",
    longEntry: { op: "and", a: { op: "gt", a: close, b: sma(b.smaWin) }, b: { op: "lt", a: { op: "choppiness", src: close, period: Cn(14) }, b: Cn(b.chopThr) } } as StrategyDoc["longEntry"],
    longExit: { op: "lt", a: close, b: sma(b.smaWin) } as StrategyDoc["longExit"],
    params: {}, risk: { volTargetAnnual: 0.4, maxLeverage: 1, stopAtrMult: 3, trailActivate: 0.2, trailOffset: 0.08 },
  } as StrategyDoc;
}

const COST = { feeBps: 5, slipBps: 8 };
const PPY_D = 365;

// ----------------------------------------------------------------- block stream
/** A per-block daily OOS stream + its long/flat weight path, point-in-time. */
export interface BlockStream { t: number[]; ret: number[]; w: number[] }

/** Honest WF for one block: re-pick {smaWin,chopThr} per window on train data, apply
 *  to the next OOS window. Concatenate OOS daily returns. ppy=365, no look-ahead. */
export function blockWfStream(bars: Bars, base: Block, trainDays = 365, stepDays = 90): BlockStream {
  const n = bars.t.length, warm = 220;
  const T: number[] = [], R: number[] = [], W: number[] = [];
  // small per-block grid around the block's seed params (the search WITHIN a block)
  const smaGrid = [100, 120, 150, 200], chopGrid = [45, 50, 55];
  let s = warm + trainDays;
  const objTrain = (tot: number, dd: number) => tot - (Math.abs(dd) > 0.35 ? (Math.abs(dd) - 0.35) * 3 : 0);
  const statTot = (r: number[]) => { let eq = 1, pk = 1, dd = 0; for (const v of r) { eq *= 1 + v; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); } return { tot: eq - 1, dd }; };
  while (s < n - 1) {
    const ts = s - trainDays, te = s, oe = Math.min(n - 1, s + stepDays);
    let bp: Block | null = null, bo = -Infinity;
    for (const sw of smaGrid) for (const ct of chopGrid) {
      const bt = runBacktest(blockDoc({ symbol: base.symbol, smaWin: sw, chopThr: ct }), bars, {}, { cost: COST, ppy: PPY_D, startEquity: 1 }, { startI: ts, endI: te });
      const st = statTot(Array.from(bt.ret).slice(ts, te));
      const o = objTrain(st.tot, st.dd);
      if (Number.isFinite(o) && o > bo) { bo = o; bp = { symbol: base.symbol, smaWin: sw, chopThr: ct }; }
    }
    if (!bp) bp = base;
    const bt = runBacktest(blockDoc(bp), bars, {}, { cost: COST, ppy: PPY_D, startEquity: 1 }, { startI: ts, endI: oe });
    for (let i = s; i < oe; i++) { T.push(bars.t[i]); R.push(bt.ret[i]); W.push(Math.abs(bt.weights[i - 1]) > 1e-6 ? 1 : 0); }
    s += stepDays;
  }
  return { t: T, ret: R, w: W };
}

// ----------------------------------------------------------------- combine math
/** Align block streams on common UTC days. */
export function alignBlocks(streams: BlockStream[]): { t: number[]; R: number[][]; W: number[][] } {
  const key = (ts: number) => Math.floor(ts / 86400_000);
  const maps = streams.map((s) => { const m = new Map<number, { r: number; w: number }>(); s.t.forEach((ts, i) => m.set(key(ts), { r: s.ret[i], w: s.w[i] })); return m; });
  let common = [...maps[0].keys()];
  for (let i = 1; i < maps.length; i++) common = common.filter((k) => maps[i].has(k));
  common.sort((a, b) => a - b);
  return { t: common.map((k) => k * 86400_000), R: streams.map((_, si) => common.map((k) => maps[si].get(k)!.r)), W: streams.map((_, si) => common.map((k) => maps[si].get(k)!.w)) };
}

function invVolWeights(R: number[][]): number[] {
  return R.map((r) => { const m = r.reduce((a, b) => a + b, 0) / Math.max(1, r.length); const v = Math.sqrt(Math.max(1e-12, r.reduce((a, b) => a + b * b, 0) / Math.max(1, r.length) - m * m)); return 1 / v; });
}
function ercWeightsLocal(R: number[][], iters = 200): number[] {
  const N = R.length, n = R[0]?.length ?? 0;
  if (N === 1) return [1];
  const mean = R.map((r) => r.reduce((a, b) => a + b, 0) / Math.max(1, n));
  const cov: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { let c = 0; for (let k = 0; k < n; k++) c += (R[i][k] - mean[i]) * (R[j][k] - mean[j]); cov[i][j] = c / Math.max(1, n); }
  let w = invVolWeights(R); let ws = w.reduce((a, b) => a + b, 0); w = w.map((x) => x / ws);
  for (let it = 0; it < iters; it++) {
    const mrc = w.map((_, i) => { let s = 0; for (let j = 0; j < N; j++) s += cov[i][j] * w[j]; return s; });
    const rc = w.map((wi, i) => wi * mrc[i]);
    const target = rc.reduce((a, b) => a + b, 0) / N;
    for (let i = 0; i < N; i++) w[i] *= Math.pow(target / Math.max(1e-12, rc[i]), 0.1);
    ws = w.reduce((a, b) => a + b, 0); w = w.map((x) => Math.max(0, x / ws));
  }
  return w;
}

/** Resolve the per-block weights for a portfolio doc from its alloc scheme. */
export function resolveWeights(doc: CombinationDoc, R: number[][]): number[] {
  const N = R.length;
  if (doc.alloc === "equal") return new Array(N).fill(1 / N);
  if (doc.alloc === "invvol") { const w = invVolWeights(R); const s = w.reduce((a, b) => a + b, 0); return w.map((x) => x / s); }
  if (doc.alloc === "erc") return ercWeightsLocal(R);
  // concentrate: use the doc's searched concWeights (normalized), else equal
  if (doc.concWeights && doc.concWeights.length === N) { const s = doc.concWeights.reduce((a, b) => a + Math.max(0, b), 0); return s > 0 ? doc.concWeights.map((x) => Math.max(0, x) / s) : new Array(N).fill(1 / N); }
  return new Array(N).fill(1 / N);
}

/** Build the COMBINED OOS return stream for a combination doc from its block
 *  streams. Portfolio = weighted sum × leverage (with honest borrow on exposed
 *  days). Overlay = base block return scaled by the gate block's long/flat regime.
 *  Returns the pooled daily return stream + its timestamp axis (point-in-time). */
export function combinedStream(doc: CombinationDoc, blockStreams: BlockStream[]): { t: number[]; ret: number[] } {
  const al = alignBlocks(blockStreams);
  const lev = Math.max(1, doc.leverage);
  const out: number[] = [];
  if (doc.mode === "overlay") {
    // [base, gate]: base earns only when the gate block is ALSO long (regime agree)
    for (let i = 0; i < al.t.length; i++) {
      const gate = al.W[1][i] > 0 ? 1 : 0;
      let dr = lev * (al.R[0][i] * gate);
      if (lev > 1 && Math.abs(al.R[0][i] * gate) > 1e-9) dr -= (lev - 1) * (0.10 / 365);
      out.push(dr);
    }
    return { t: al.t, ret: out };
  }
  // portfolio: weighted sum of block returns × leverage
  const w = resolveWeights(doc, al.R);
  for (let i = 0; i < al.t.length; i++) {
    let acc = 0; for (let s = 0; s < al.R.length; s++) acc += w[s] * al.R[s][i];
    let dr = lev * acc;
    if (lev > 1 && Math.abs(acc) > 1e-9) dr -= (lev - 1) * (0.10 / 365);
    out.push(dr);
  }
  return { t: al.t, ret: out };
}
