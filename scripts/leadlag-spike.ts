// LEAD-LAG / NETWORK-MOMENTUM FEASIBILITY SPIKE (script only — NOT wired).
//
// The one mechanism not covered by the exhaustion verdict: a coin's NEXT return
// is predicted by the LAGGED signals of OTHER (leading) coins — cross-asset
// prediction, not own-trend. So it EXPLOITS cross-asset correlation rather than
// being killed by it. Long-flat: long the coins whose leaders' recent signals
// point up.
//
// Two estimators, both TRAILING-ONLY (no look-ahead — the #1 lead-lag trap):
//   (1) BTC-lead: predict each alt's next return from BTC's recent return (the
//       dominance lead-lag). Network score_i(t) = sign/size of BTC's trailing
//       move (same for all alts) -> degenerate; so we use the per-coin BETA to
//       BTC's LAGGED return, estimated on trailing data, * BTC's latest move.
//   (2) Cross-asset lead-lag matrix: for each coin i, predict r_i(t+1) from the
//       lagged returns of ALL coins j over a trailing window (ridge-lite: rank by
//       sum_j corr_trailing(r_j[t-1], r_i[t]) * r_j(latest)). "Follow the Leader".
//
// CRITICAL: every coefficient/correlation uses ONLY bars <= t. Probed below by
// corrupting future bars and confirming the past signal is unchanged.

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { loadBars } from "../src/lib/data";
import { getAppConfig } from "../src/pipeline/process";
import { alignUniverse, type XAligned } from "../src/engine/xsection";
import { pearson, statsOf, type Stream } from "../src/engine/book";
import { DEFAULT_FEE_BPS, SLIP_BPS, PPY, type Bars } from "../src/engine/types";
import { generateXSection } from "../src/engine/xsectionGen";
import { backtestXSection } from "../src/engine/xsection";

const TF = "4h" as const;
const PPY4 = PPY[TF]!;
const FEE = DEFAULT_FEE_BPS;
const slipOf = (s: string) => SLIP_BPS[s] ?? 5;

function corrA(a: Stream, b: Stream): number {
  const bm = new Map<number, number>(); b.t.forEach((t, i) => bm.set(t, b.ret[i]));
  const av: number[] = [], bv: number[] = [];
  a.t.forEach((t, i) => { const x = bm.get(t); if (x !== undefined) { av.push(a.ret[i]); bv.push(x); } });
  return av.length > 30 ? pearson(av, bv) : 0;
}

/** Trailing Pearson of x[k-lag] vs y[k] over window ending at i-1 (info <= i-1). */
function trailingLeadCorr(x: number[], y: number[], i: number, win: number, lag: number): number {
  const lo = Math.max(lag + 1, i - win), hi = i - 1;
  if (hi - lo < 30) return 0;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
  for (let k = lo; k <= hi; k++) { const a = x[k - lag], b = y[k]; sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b; n++; }
  const cov = sxy / n - (sx / n) * (sy / n);
  const vx = sxx / n - (sx / n) ** 2, vy = syy / n - (sy / n) ** 2;
  return vx > 1e-12 && vy > 1e-12 ? cov / Math.sqrt(vx * vy) : 0;
}

/**
 * Network-momentum score for each coin at each bar, TRAILING-ONLY.
 * score_i(t) = sum_j  leadCorr_trailing(r_j -> r_i)  *  r_j(t)
 * i.e. coin i is predicted UP if coins j that have historically LED i are up now.
 * The lead-corr is recomputed on a trailing window (slow grid, cached) so the
 * matrix never uses future data. Long the top-K by score.
 */
function networkScores(A: XAligned, win: number, lag: number, recomputeEvery: number): Float64Array[] {
  const S = A.symbols.length, n = A.t.length;
  const r = A.ret; // per-coin simple returns
  const scores: Float64Array[] = Array.from({ length: S }, () => new Float64Array(n));
  // lead-corr matrix L[i][j] = trailing corr of r_j[t-lag] -> r_i[t], recomputed
  // on the grid. At bar i we use the matrix estimated as of i (trailing only).
  let L: number[][] = Array.from({ length: S }, () => new Float64Array(S) as unknown as number[]);
  for (let i = win + lag + 1; i < n; i++) {
    if ((i - win - lag - 1) % recomputeEvery === 0) {
      L = Array.from({ length: S }, () => new Array(S).fill(0));
      for (let ii = 0; ii < S; ii++) for (let jj = 0; jj < S; jj++) {
        if (ii === jj) continue;
        L[ii][jj] = trailingLeadCorr(r[jj], r[ii], i, win, lag); // r_j leads r_i
      }
    }
    for (let ii = 0; ii < S; ii++) {
      let sc = 0;
      for (let jj = 0; jj < S; jj++) { if (ii === jj) continue; sc += L[ii][jj] * r[jj][i]; } // leaders' move now
      scores[ii][i] = sc;
    }
  }
  return scores;
}

/** Backtest a long-flat sleeve from a precomputed per-coin score matrix. */
function backtestFromScores(
  A: XAligned, scores: Float64Array[], topK: number, rebalEvery: number, warmup: number, volTargetAnnual: number,
): { ret: Float64Array; t: number[] } {
  const S = A.symbols.length, n = A.t.length;
  const w = Array.from({ length: S }, () => new Float64Array(n));
  let cur = new Array(S).fill(0);
  for (let i = warmup; i < n; i++) {
    if ((i - warmup) % rebalEvery === 0) {
      const ord: [number, number][] = [];
      for (let k = 0; k < S; k++) { const sc = scores[k][i]; if (Number.isFinite(sc) && sc !== 0) ord.push([sc, k]); }
      ord.sort((a, b) => b[0] - a[0]);
      cur = new Array(S).fill(0);
      const picks = ord.slice(0, topK);
      for (const [, k] of picks) cur[k] = picks.length ? 1 / picks.length : 0; // LONG-FLAT
    }
    for (let k = 0; k < S; k++) w[k][i] = cur[k];
  }
  const raw = new Float64Array(n);
  for (let i = warmup + 1; i < n; i++) {
    let g = 0, c = 0, f = 0;
    for (let k = 0; k < S; k++) { const wk = w[k][i - 1]; g += wk * A.ret[k][i]; const dw = Math.abs(w[k][i - 1] - (w[k][i - 2] ?? 0)); c += dw * (FEE + slipOf(A.symbols[k])) / 1e4; f += wk * A.funding[k][i]; }
    raw[i] = g - c - f;
  }
  let s = 0, sq = 0, cnt = 0; for (let i = warmup + 1; i < n; i++) { s += raw[i]; sq += raw[i] * raw[i]; cnt++; }
  const sd = Math.sqrt(Math.max(0, sq / Math.max(1, cnt) - (s / Math.max(1, cnt)) ** 2));
  const lev = sd * Math.sqrt(PPY4) > 1e-9 ? Math.min(3, volTargetAnnual / (sd * Math.sqrt(PPY4))) : 1;
  const out = new Float64Array(n);
  for (let i = warmup + 1; i < n; i++) out[i] = Math.max(-0.95, raw[i] * lev);
  return { ret: out, t: A.t };
}

/** Purged WF: re-select {topK, rebalEvery, leadWin, lag} on train, trade OOS. */
function purgedWfNetwork(A: XAligned): { oos: Float64Array; t: number[]; sharpe: number; pct: number } {
  const n = A.t.length;
  const trainBars = Math.floor(PPY4 * 1.0), testBars = Math.floor(PPY4 * 0.25), purge = 60;
  const grids = [
    { win: 240, lag: 1, k: 5, reb: 3 }, { win: 480, lag: 1, k: 6, reb: 6 },
    { win: 240, lag: 2, k: 6, reb: 6 }, { win: 360, lag: 1, k: 8, reb: 6 },
  ];
  const pooled: number[] = [], pooledT: number[] = [];
  let start = trainBars;
  while (start + testBars < n) {
    let best: { g: typeof grids[number]; sh: number } | null = null;
    for (const g of grids) {
      const sc = networkScores(A, g.win, g.lag, 120);
      const bt = backtestFromScores(A, sc, g.k, g.reb, g.win + g.lag + 2, 0.4);
      const sh = statsOf(Array.from(bt.ret.slice(g.win + g.lag + 2, start - purge)), PPY4).sharpe;
      if (!best || sh > best.sh) best = { g, sh };
    }
    const g = best!.g;
    const sc = networkScores(A, g.win, g.lag, 120);
    const bt = backtestFromScores(A, sc, g.k, g.reb, g.win + g.lag + 2, 0.4);
    for (let i = start; i < start + testBars && i < bt.ret.length; i++) { pooled.push(bt.ret[i]); pooledT.push(A.t[i]); }
    start += testBars;
  }
  const oos = Float64Array.from(pooled);
  const sh = statsOf(pooled, PPY4).sharpe;
  const perMonth = Math.floor(PPY4 / 12); let pos = 0, mo = 0;
  for (let i = 0; i < pooled.length; i += perMonth) { let gg = 1; for (let j = i; j < Math.min(i + perMonth, pooled.length); j++) gg *= 1 + pooled[j]; if (gg - 1 > 0) pos++; mo++; }
  return { oos, t: pooledT, sharpe: sh, pct: mo ? pos / mo : 0 };
}

async function main() {
  const cx = new ConvexHttpClient(process.env.CONVEX_URL!);
  const cfg = await getAppConfig(cx);
  const barsList: { symbol: string; bars: Bars }[] = [];
  for (const s of cfg.universe) { const b = await loadBars(s, TF); if (b && b.t.length > PPY4 * 1.7) barsList.push({ symbol: s, bars: b }); }
  const A = alignUniverse(barsList);
  console.log(`universe ${A.symbols.length} coins, ${A.t.length} ${TF} bars\n`);

  // ===== CRITICAL LOOK-AHEAD PROBE on the network score =====
  // Build scores on full A; corrupt all bars AFTER mid; scores on [0,mid] must be unchanged.
  const win = 240, lag = 1;
  const scFull = networkScores(A, win, lag, 120);
  const mid = Math.floor(A.t.length * 0.5);
  const A2: XAligned = { ...A, ret: A.ret.map((r) => r.slice()), close: A.close.map((c) => c.slice()), funding: A.funding.map((f) => f.slice()) };
  for (let k = 0; k < A2.symbols.length; k++) for (let i = mid + 1; i < A2.t.length; i++) { A2.ret[k][i] = 0.1; A2.close[k][i] *= 1.5; }
  const scCorrupt = networkScores(A2, win, lag, 120);
  let maxDiff = 0; for (let k = 0; k < A.symbols.length; k++) for (let i = win + lag + 2; i <= mid; i++) maxDiff = Math.max(maxDiff, Math.abs(scFull[k][i] - scCorrupt[k][i]));
  console.log(`LOOK-AHEAD PROBE (network score): max |diff| on [0,mid] after corrupting future = ${maxDiff.toExponential(2)}`);
  console.log(`  -> ${maxDiff < 1e-9 ? "PASS (no look-ahead)" : "FAIL — future leaked into past lead-lag matrix!"}\n`);

  // ===== decisive numbers: lead-lag network OOS Sharpe + corr to momentum =====
  const wf = purgedWfNetwork(A);
  const llStream: Stream = { id: "leadlag_network", t: wf.t, ret: wf.oos };

  // momentum reference (cross-sectional trend OOS, same harness)
  const tdoc = generateXSection(42, "trend");
  const fp = (k: number, r: number) => { const p: Record<string, number> = { topK: k, rebalEvery: r }; for (const [kk, sp] of Object.entries(tdoc.params ?? {})) p[kk] = sp.default; return p; };
  const tbt = backtestXSection(tdoc, A, fp(tdoc.topK, tdoc.rebalEvery), PPY4, { startI: tdoc.lookback + 1, endI: A.t.length - 1 });
  const momRef: Stream = { id: "momentum", t: A.t, ret: tbt.ret };

  const corrMom = Math.abs(corrA(llStream, momRef));
  console.log("=== LEAD-LAG / NETWORK-MOMENTUM (purged WF, realistic costs) ===");
  console.log(`  OOS Sharpe = ${wf.sharpe.toFixed(2)} | monthly-positive ${(wf.pct * 100).toFixed(0)}% | |corr to momentum| = ${corrMom.toFixed(2)}`);
  console.log(`  WIN CONDITION (OOS>=0.4 AND corr<=0.4): ${wf.sharpe >= 0.4 && corrMom <= 0.4 ? "*** WIN ***" : (corrMom <= 0.4 ? "orthogonal but thin/dead" : "still correlated")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
