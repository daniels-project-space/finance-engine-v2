// CROSS-SECTIONAL FEASIBILITY SPIKE (Step 3 — NOT wired into generation).
//
// Proves whether a LONG-BIASED cross-sectional sleeve has an edge on OUR data
// and realistic costs, and whether it DIVERSIFIES the existing per-symbol sleeves.
// Two sleeves, both LONG-FLAT (never short — crypto shorts get liquidated; profit
// is all the long leg):
//   (a) cross-sectional TREND rank: long the top-K by trailing return, hold, rebal.
//   (b) cross-sectional REVERSAL: long the bottom-K by recent return (losers' rebound).
//
// Costs: engine constants (5bps fee + per-symbol slip + per-bar funding). Sizing:
// equal-weight across the K longs, vol-targeted at the book level. NO look-ahead:
// ranking uses only info available at the rebalance bar (trailing returns up to t).
// Honest evaluation: purged walk-forward OOS Sharpe + correlation to existing sleeves.

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { loadBars } from "../src/lib/data";
import { DEFAULT_FEE_BPS, SLIP_BPS, PPY, type Bars } from "../src/engine/types";
import { pearson, statsOf, type Stream } from "../src/engine/book";
import { runGauntlet } from "../src/engine/gauntlet";
import { getAppConfig } from "../src/pipeline/process";
import type { StrategyDoc } from "../src/engine/types";

const TF = "4h" as const;           // rebalance grid; 4h keeps turnover sane
const PPY4 = PPY[TF] ?? 2190;
const slipOf = (sym: string) => SLIP_BPS[sym] ?? 5;   // mid-caps: 5bps default
const FEE = DEFAULT_FEE_BPS;

type Aligned = { t: number[]; symbols: string[]; close: number[][]; funding: number[][] };

/** Align all symbols on their COMMON timestamp set (inner join on bar opens). */
function alignAll(barsList: { sym: string; bars: Bars }[]): Aligned {
  // common timestamps = intersection
  const sets = barsList.map((b) => new Set(b.bars.t));
  const base = barsList[0].bars.t.filter((t) => sets.every((s) => s.has(t)));
  const idxMaps = barsList.map((b) => { const m = new Map<number, number>(); b.bars.t.forEach((t, i) => m.set(t, i)); return m; });
  const close: number[][] = [], funding: number[][] = [];
  for (let s = 0; s < barsList.length; s++) {
    const b = barsList[s].bars; const im = idxMaps[s];
    // per-bar funding map
    const fmap = new Map<number, number>();
    if (b.fundingT && b.fundingR) for (let i = 0; i < b.fundingT.length; i++) {
      // attach funding to the bar whose open >= funding stamp (same rule as backtest)
      const ft = b.fundingT[i]; const bi = b.t.findIndex((tt) => tt >= ft);
      if (bi >= 0) fmap.set(b.t[bi], (fmap.get(b.t[bi]) ?? 0) + b.fundingR[i]);
    }
    const c: number[] = [], f: number[] = [];
    for (const t of base) { const i = im.get(t)!; c.push(b.c[i]); f.push(fmap.get(t) ?? 0); }
    close.push(c); funding.push(f);
  }
  return { t: base, symbols: barsList.map((b) => b.sym), close, funding };
}

/** Backtest a long-flat cross-sectional sleeve. `rankFn(retMatrix, i)` returns the
 *  per-symbol score at bar i (using ONLY data up to i). Long top-K (trend) or
 *  bottom-K (reversal, via sign). Returns the per-bar net return stream. */
function backtestXS(
  A: Aligned, opts: { lookback: number; rebalEvery: number; topK: number; reversal: boolean; volTargetAnnual: number },
): { ret: Float64Array; t: number[] } {
  const S = A.symbols.length, n = A.t.length;
  // per-symbol simple returns
  const r: number[][] = A.close.map((c) => { const out = new Array(n).fill(0); for (let i = 1; i < n; i++) out[i] = c[i - 1] > 0 ? c[i] / c[i - 1] - 1 : 0; return out; });
  const w = Array.from({ length: S }, () => new Float64Array(n)); // target weights held into bar i+1
  const { lookback, rebalEvery, topK, reversal } = opts;
  let curW = new Array(S).fill(0);
  for (let i = lookback + 1; i < n; i++) {
    if ((i - lookback - 1) % rebalEvery === 0) {
      // score = trailing return over lookback (info up to and including bar i)
      const score = A.close.map((c) => (c[i - lookback] > 0 ? c[i] / c[i - lookback] - 1 : -1e9));
      const order = score.map((s, k) => [s, k] as [number, number]).sort((a, b) => reversal ? a[0] - b[0] : b[0] - a[0]);
      const picks = order.slice(0, topK).map((x) => x[1]);
      curW = new Array(S).fill(0);
      for (const k of picks) curW[k] = 1 / topK; // equal-weight the K longs (long-flat: weights >=0)
    }
    for (let k = 0; k < S; k++) w[k][i] = curW[k];
  }
  // realize per-bar net returns: sum_k w_k * (r_k - turnover_cost_k - funding_k)
  const ret = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    let gross = 0, cost = 0, fund = 0;
    for (let k = 0; k < S; k++) {
      const wk = w[k][i - 1]; // weight decided at i-1 earns bar i return
      gross += wk * r[k][i];
      const dw = Math.abs(w[k][i - 1] - (w[k][i - 2] ?? 0));
      cost += dw * (FEE + slipOf(A.symbols[k])) / 10_000;
      fund += wk * A.funding[k][i]; // long pays positive funding
    }
    ret[i] = gross - cost - fund;
  }
  // book-level vol target: scale the whole stream to the target annual vol
  const sd = Math.sqrt(variance(ret, lookback + 2, n - 1));
  const annVol = sd * Math.sqrt(PPY4);
  const scale = annVol > 1e-9 ? Math.min(3, opts.volTargetAnnual / annVol) : 1; // cap leverage at 3x
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = ret[i] * scale;
  return { ret: out, t: A.t };
}

function variance(a: Float64Array, from: number, to: number): number {
  let s = 0, sq = 0, n = 0;
  for (let i = from; i <= to; i++) { s += a[i]; sq += a[i] * a[i]; n++; }
  const m = s / Math.max(1, n);
  return sq / Math.max(1, n) - m * m;
}

/** Purged walk-forward OOS: re-pick the BEST {lookback,topK} on each trailing
 *  train window, trade it OOS on the next window. Honest — no test-window info in
 *  selection. Returns the pooled OOS return stream. */
function purgedWfXS(A: Aligned, reversal: boolean): { oos: Float64Array; t: number[]; sharpe: number; pct: number } {
  const n = A.t.length;
  const trainBars = Math.floor(PPY4 * 1.0);    // ~1y train
  const testBars = Math.floor(PPY4 * 0.25);    // ~3mo test
  const purge = 30;                            // purge band
  const lookbacks = reversal ? [3, 6, 12] : [30, 60, 120];
  const topKs = [4, 6, 8];
  const pooled: number[] = [], pooledT: number[] = [];
  let start = trainBars;
  while (start + testBars < n) {
    // select best config on the train window by in-sample Sharpe
    let best: { lb: number; k: number; sh: number } | null = null;
    for (const lb of lookbacks) for (const k of topKs) {
      const sub = sliceAligned(A, 0, start - purge);
      const bt = backtestXS(sub, { lookback: lb, rebalEvery: 6, topK: k, reversal, volTargetAnnual: 0.4 });
      const sh = statsOf(Array.from(bt.ret.slice(lb + 2)), PPY4).sharpe;
      if (!best || sh > best.sh) best = { lb, k, sh };
    }
    // trade OOS on [start, start+testBars) with the selected config
    const sub = sliceAligned(A, 0, start + testBars);
    const bt = backtestXS(sub, { lookback: best!.lb, rebalEvery: 6, topK: best!.k, reversal, volTargetAnnual: 0.4 });
    for (let i = start; i < start + testBars && i < bt.ret.length; i++) { pooled.push(bt.ret[i]); pooledT.push(A.t[i]); }
    start += testBars;
  }
  const oos = Float64Array.from(pooled);
  const sh = statsOf(pooled, PPY4).sharpe;
  let pos = 0, mo = 0; // crude monthly positivity
  const perMonth = Math.floor(PPY4 / 12);
  for (let i = 0; i < pooled.length; i += perMonth) { let s = 0; for (let j = i; j < Math.min(i + perMonth, pooled.length); j++) s += pooled[j]; if (s > 0) pos++; mo++; }
  return { oos, t: pooledT, sharpe: sh, pct: mo ? pos / mo : 0 };
}

function sliceAligned(A: Aligned, from: number, to: number): Aligned {
  return { t: A.t.slice(from, to), symbols: A.symbols, close: A.close.map((c) => c.slice(from, to)), funding: A.funding.map((f) => f.slice(from, to)) };
}

async function main() {
  const cx = new ConvexHttpClient(process.env.CONVEX_URL!);
  const cfg = await getAppConfig(cx);
  const universe: string[] = cfg.universe;
  console.log(`loading ${universe.length} symbols @ ${TF}...`);
  const barsList: { sym: string; bars: Bars }[] = [];
  for (const sym of universe) { const b = await loadBars(sym, TF); if (b && b.t.length > 1000) barsList.push({ sym, bars: b }); else console.log(`  (skip ${sym}: insufficient bars)`); }
  console.log(`aligning ${barsList.length} symbols...`);
  const A = alignAll(barsList);
  console.log(`common window: ${A.t.length} ${TF} bars (${new Date(A.t[0]).toISOString().slice(0, 10)} -> ${new Date(A.t[A.t.length - 1]).toISOString().slice(0, 10)})\n`);

  // ===== the two decisive numbers per sleeve =====
  const results: { name: string; stream: Stream; oosSharpe: number; pct: number }[] = [];
  for (const [name, reversal] of [["xs_trend", false], ["xs_reversal", true]] as const) {
    const wf = purgedWfXS(A, reversal);
    console.log(`${name}: purged-WF OOS Sharpe = ${wf.sharpe.toFixed(2)} | monthly-positive ${(wf.pct * 100).toFixed(0)}% | OOS bars ${wf.oos.length}`);
    results.push({ name, stream: { id: name, t: wf.t, ret: wf.oos }, oosSharpe: wf.sharpe, pct: wf.pct });
  }

  // ===== correlation to the existing per-symbol sleeves =====
  console.log("\nre-streaming existing per-symbol sleeves for correlation...");
  const existingNames = ["mut_4kz9", "opus_oi_expansion_breakout_4h", "xo_3qfp"];
  const failed = await cx.query(api.candidates.listByStage, { stage: "failed", limit: 1000 }) as any[];
  const ppy4 = PPY["4h"]!; const sealTs = Date.parse(cfg.sealDate);
  const primary = await loadBars(cfg.primarySymbol, "4h");
  const others: Bars[] = [];
  for (const sym of universe.slice(0, 5)) { if (sym === cfg.primarySymbol) continue; const b = await loadBars(sym, "4h"); if (b) others.push(b); }
  const pAlt = await loadBars(cfg.primarySymbol, "1h"); if (pAlt) others.push(pAlt);
  const existing: Stream[] = [];
  for (const nm of existingNames) {
    const r = failed.find((x: any) => x.name === nm); if (!r) continue;
    let doc: StrategyDoc; try { doc = JSON.parse(r.dsl); } catch { continue; }
    try {
      const rep = runGauntlet({ doc, primary: primary!, others, sealTs, floors: cfg.floors, nTrialsTotal: 40, binding: { purgedWf: cfg.walkforward.purged, pbo: { bind: cfg.shadowRigor.pbo.bind, max: cfg.shadowRigor.pbo.max, blocks: cfg.shadowRigor.pboBlocks }, regime: { bind: cfg.shadowRigor.regime.bind, minSharpe: cfg.shadowRigor.regime.minSharpe, minObs: cfg.shadowRigor.regime.minObs, maxPnlConcentration: cfg.shadowRigor.regime.maxPnlConcentration } } });
      if (rep.portfolioOos) existing.push({ id: nm, t: rep.portfolioOos.t, ret: Float64Array.from(rep.portfolioOos.ret) });
    } catch {}
  }
  console.log(`\n=== CORRELATION: cross-sectional sleeves vs existing per-symbol sleeves ===`);
  console.log("            " + existing.map((e) => e.id.slice(0, 10).padStart(11)).join(""));
  for (const xs of results) {
    const row = existing.map((e) => corrAligned(xs.stream, e).toFixed(2).padStart(11)).join("");
    console.log(`${xs.name.padEnd(12)}${row}`);
  }
  console.log("\n=== DECISIVE NUMBERS ===");
  for (const xs of results) {
    const maxCorr = existing.length ? Math.max(...existing.map((e) => Math.abs(corrAligned(xs.stream, e)))) : 0;
    console.log(`  ${xs.name}: OOS Sharpe ${xs.oosSharpe.toFixed(2)} (costs+funding), max|corr| to existing = ${maxCorr.toFixed(2)}`);
  }
}

/** Pearson on the COMMON timestamps of two streams. */
function corrAligned(a: Stream, b: Stream): number {
  const bm = new Map<number, number>(); b.t.forEach((t, i) => bm.set(t, b.ret[i]));
  const av: number[] = [], bv: number[] = [];
  a.t.forEach((t, i) => { const bi = bm.get(t); if (bi !== undefined) { av.push(a.ret[i]); bv.push(bi); } });
  return av.length > 30 ? pearson(av, bv) : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
