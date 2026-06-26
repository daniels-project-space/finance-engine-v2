// BETA-HEDGE FEASIBILITY SPIKE (script only — NOT wired into generation).
//
// Hypothesis: the positive long-flat cross-sectional sleeves (trend/carry/basis)
// are ~0.83 correlated to momentum because long-flat crypto baskets share MARKET
// BETA. Beta-hedging strips that out: long the ranked basket, SHORT a liquid
// market proxy (BTC perp) sized to neutralize the basket's trailing beta. What
// remains is the cross-sectional RESIDUAL. The only short is liquid BTC — the
// standard market-neutral hedge, NOT the liquidated-alt-shorts trap.
//
// Decisive output per base sleeve: residual OOS Sharpe (BOTH legs' costs) AND its
// correlation to the momentum cluster; how much of the basket Sharpe survives;
// the hedge cost drag.
//
// Discipline: beta estimated on TRAILING data only (rolling regression, no
// look-ahead). Long basket stays long-flat; BTC short is the only short. Costs on
// both legs (fee+slip+funding on the basket; BTC-perp funding + slip on the hedge,
// re-charged as beta drifts at each rebalance).

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { loadBars } from "../src/lib/data";
import { getAppConfig } from "../src/pipeline/process";
import { generateXSection, type XSectionFlavor } from "../src/engine/xsectionGen";
import { alignUniverse, backtestXSection, type XAligned, type XSectionDoc } from "../src/engine/xsection";

/** Full default param vector for a doc (topK/rebalEvery + ALL rank-signal params).
 *  Without the rank-signal params (lb/fwin/...), evalNum returns NaN => no picks => zero returns. */
function fullParams(doc: XSectionDoc, topK: number, rebalEvery: number): Record<string, number> {
  const p: Record<string, number> = { topK, rebalEvery };
  for (const [k, sp] of Object.entries(doc.params ?? {})) p[k] = sp.default;
  return p;
}
import { pearson, statsOf, type Stream } from "../src/engine/book";
import { DEFAULT_FEE_BPS, SLIP_BPS, PPY, type Bars } from "../src/engine/types";

const TF = "4h" as const;
const PPY4 = PPY[TF]!;
const FEE = DEFAULT_FEE_BPS;
const BTC_SLIP = SLIP_BPS["BTC/USDT"] ?? 1.5;

function corrA(a: Stream, b: Stream): number {
  const bm = new Map<number, number>(); b.t.forEach((t, i) => bm.set(t, b.ret[i]));
  const av: number[] = [], bv: number[] = [];
  a.t.forEach((t, i) => { const x = bm.get(t); if (x !== undefined) { av.push(a.ret[i]); bv.push(x); } });
  return av.length > 30 ? pearson(av, bv) : 0;
}

/** Build the BTC market-proxy per-bar return + per-bar funding on the aligned grid. */
function btcLeg(A: XAligned, btcBars: Bars): { ret: Float64Array; funding: Float64Array } {
  const im = new Map<number, number>(); btcBars.t.forEach((t, i) => im.set(t, i));
  const fmap = new Map<number, number>();
  if (btcBars.fundingT && btcBars.fundingR) { let bi = 0; for (let fi = 0; fi < btcBars.fundingT.length; fi++) { const ft = btcBars.fundingT[fi]; while (bi < btcBars.t.length - 1 && btcBars.t[bi] < ft) bi++; if (btcBars.t[bi] >= ft) fmap.set(btcBars.t[bi], (fmap.get(btcBars.t[bi]) ?? 0) + btcBars.fundingR[fi]); } }
  const n = A.t.length; const ret = new Float64Array(n), fund = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const si = im.get(A.t[i]);
    if (si === undefined || si === 0) { ret[i] = 0; fund[i] = 0; continue; }
    ret[i] = btcBars.c[si - 1] > 0 ? btcBars.c[si] / btcBars.c[si - 1] - 1 : 0;
    fund[i] = fmap.get(A.t[i]) ?? 0;
  }
  return { ret, funding: fund };
}

/** Rolling trailing beta of basket vs market over `win` bars, ending at i-1
 *  (uses ONLY past data — no look-ahead). Returns beta for use on bar i. */
function trailingBeta(basket: Float64Array, market: Float64Array, i: number, win: number): number {
  const lo = Math.max(1, i - win), hi = i - 1;
  if (hi - lo < 30) return 1; // not enough history → assume beta 1
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (let k = lo; k <= hi; k++) { const x = market[k], y = basket[k]; sx += x; sy += y; sxx += x * x; sxy += x * y; n++; }
  const cov = sxy / n - (sx / n) * (sy / n);
  const varx = sxx / n - (sx / n) * (sx / n);
  return varx > 1e-12 ? cov / varx : 1;
}

/** Beta-hedge a base long-flat sleeve. Returns the residual (hedged) OOS return
 *  stream net of BOTH legs' costs. `basketRet` is the UNIT-GROSS basket stream
 *  (before vol-target) so we can hedge it cleanly, then vol-target the residual. */
function betaHedge(
  basketRet: Float64Array, market: { ret: Float64Array; funding: Float64Array },
  t: number[], startI: number, betaWin: number, volTargetAnnual: number,
): { ret: Float64Array; betas: number[]; hedgeCostDrag: number } {
  const n = basketRet.length;
  const resid = new Float64Array(n);
  const betas: number[] = [];
  let prevBeta = 0;
  let hedgeCostSum = 0, grossSum = 0;
  for (let i = startI; i < n; i++) {
    const beta = Math.max(0, Math.min(3, trailingBeta(basketRet, market.ret, i, betaWin))); // clamp, long-flat basket so beta>=0
    betas.push(beta);
    // residual = basket - beta*market ; short beta*notional of BTC
    const gross = basketRet[i] - beta * market.ret[i];
    // hedge costs: (a) BTC funding on the SHORT (short pays -funding => receives +funding when funding positive; sign: short position earns +funding when longs pay) → being short, you RECEIVE funding when funding>0, i.e. PnL += beta*funding; but to be conservative we treat funding as a cost-or-credit symmetrically:
    const hedgeFunding = beta * market.funding[i]; // short BTC: receives funding when funding>0 (longs pay). PnL contribution = +beta*funding... but the basket longs already PAID their funding inside basketRet. Net hedge funding on the short leg:
    // (we ADD the short's funding credit; sign chosen so positive funding helps the short)
    const hedgeFundingPnl = beta * market.funding[i];
    // (b) slippage on rebalancing the hedge notional as beta drifts
    const dBeta = Math.abs(beta - prevBeta);
    const hedgeSlip = dBeta * (FEE + BTC_SLIP) / 10_000;
    const net = gross + hedgeFundingPnl - hedgeSlip;
    void hedgeFunding;
    resid[i] = net;
    hedgeCostSum += hedgeSlip; grossSum += Math.abs(gross);
    prevBeta = beta;
  }
  // vol-target the residual
  let s = 0, sq = 0, c = 0; for (let i = startI; i < n; i++) { s += resid[i]; sq += resid[i] * resid[i]; c++; }
  const mean = s / Math.max(1, c), sd = Math.sqrt(Math.max(0, sq / Math.max(1, c) - mean * mean));
  const annVol = sd * Math.sqrt(PPY4);
  const lev = annVol > 1e-9 ? Math.min(3, volTargetAnnual / annVol) : 1;
  const out = new Float64Array(n);
  for (let i = startI; i < n; i++) out[i] = Math.max(-0.95, resid[i] * lev);
  return { ret: out, betas, hedgeCostDrag: grossSum > 0 ? hedgeCostSum / grossSum : 0 };
}

/** Purged WF for a beta-hedged sleeve: per window, re-select {topK,rebalEvery}
 *  on the train span (on the HEDGED residual Sharpe), trade OOS. */
function purgedWfHedged(
  flavor: XSectionFlavor, A: XAligned, market: { ret: Float64Array; funding: Float64Array }, betaWin: number,
): { oos: Float64Array; t: number[]; sharpe: number; pct: number } {
  const n = A.t.length;
  const trainBars = Math.floor(PPY4 * 1.0), testBars = Math.floor(PPY4 * 0.25), purge = 40;
  const seeds = [11, 42, 77];
  const topKs = [4, 6, 8], rebs = [3, 6, 12];
  const pooled: number[] = [], pooledT: number[] = [];
  let start = trainBars;
  while (start + testBars < n) {
    // select the {seed,topK,rebalEvery} that maximizes the HEDGED residual Sharpe
    // on the TRAIN span (purged), then trade that config OOS on the next window.
    let bestCfg = { seed: 11, k: 6, reb: 6 }; let bestSh = -Infinity;
    for (const seed of seeds) for (const k of topKs) for (const reb of rebs) {
      const doc = generateXSection(seed, flavor);
      const bt = backtestXSection({ ...doc, topK: k, rebalEvery: reb }, A, fullParams(doc, k, reb), PPY4, { startI: doc.lookback + 1, endI: start - purge });
      const h = betaHedge(bt.ret, market, A.t, doc.lookback + 1, betaWin, 0.4);
      const sh = statsOf(Array.from(h.ret.slice(doc.lookback + 2, start - purge)), PPY4).sharpe;
      if (sh > bestSh) { bestSh = sh; bestCfg = { seed, k, reb }; }
    }
    const doc = generateXSection(bestCfg.seed, flavor);
    const bt = backtestXSection({ ...doc, topK: bestCfg.k, rebalEvery: bestCfg.reb }, A, fullParams(doc, bestCfg.k, bestCfg.reb), PPY4, { startI: doc.lookback + 1, endI: start + testBars });
    const h = betaHedge(bt.ret, market, A.t, doc.lookback + 1, betaWin, 0.4);
    for (let i = start; i < start + testBars && i < h.ret.length; i++) { pooled.push(h.ret[i]); pooledT.push(A.t[i]); }
    start += testBars;
  }
  const oos = Float64Array.from(pooled);
  const sh = statsOf(pooled, PPY4).sharpe;
  const perMonth = Math.floor(PPY4 / 12); let pos = 0, mo = 0;
  for (let i = 0; i < pooled.length; i += perMonth) { let g = 1; for (let j = i; j < Math.min(i + perMonth, pooled.length); j++) g *= 1 + pooled[j]; if (g - 1 > 0) pos++; mo++; }
  return { oos, t: pooledT, sharpe: sh, pct: mo ? pos / mo : 0 };
}

async function main() {
  const cx = new ConvexHttpClient(process.env.CONVEX_URL!);
  const cfg = await getAppConfig(cx);
  const barsList: { symbol: string; bars: Bars }[] = [];
  for (const s of cfg.universe) { const b = await loadBars(s, TF); if (b && b.t.length > PPY4 * 1.7) barsList.push({ symbol: s, bars: b }); }
  const A = alignUniverse(barsList);
  const btcBars = barsList.find((b) => b.symbol === "BTC/USDT")!.bars;
  const market = btcLeg(A, btcBars);
  console.log(`universe ${A.symbols.length} coins, ${A.t.length} ${TF} bars; market proxy = BTC perp\n`);

  const betaWin = 120; // ~20 days trailing for beta
  const flavors: XSectionFlavor[] = ["trend", "carry_funding", "basis_disloc"];

  // unhedged baselines (for "how much survives") + momentum reference stream
  const unhedged: Record<string, Stream> = {};
  for (const fl of flavors) {
    const doc = generateXSection(42, fl);
    const bt = backtestXSection(doc, A, fullParams(doc, doc.topK, doc.rebalEvery), PPY4, { startI: doc.lookback + 1, endI: A.t.length - 1 });
    unhedged[fl] = { id: fl, t: A.t, ret: bt.ret };
  }
  const momRef = unhedged["trend"];

  console.log("=== BETA-HEDGED RESIDUALS (purged WF, both legs' costs) ===");
  const hedged: Record<string, Stream> = {};
  for (const fl of flavors) {
    const wf = purgedWfHedged(fl, A, market, betaWin);
    hedged[fl] = { id: `${fl}_hedged`, t: wf.t, ret: wf.oos };
    const corrMom = Math.abs(corrA(hedged[fl], momRef));
    const unhSh = statsOf(Array.from(unhedged[fl].ret).filter((x) => x !== 0), PPY4).sharpe;
    console.log(`${fl.padEnd(14)} unhedged Sharpe=${unhSh.toFixed(2)} -> HEDGED residual Sharpe=${wf.sharpe.toFixed(2)} | monthlyPos=${(wf.pct * 100).toFixed(0)}% | |corr to momentum|=${corrMom.toFixed(2)} | ${wf.sharpe >= 0.4 && corrMom <= 0.4 ? "*** WIN ***" : (corrMom <= 0.4 ? "orthogonal but thin" : "still correlated")}`);
  }

  console.log("\n=== correlation matrix: hedged residuals vs momentum ===");
  const all = [momRef, ...flavors.map((f) => hedged[f])];
  console.log("                    " + all.map((s) => s.id.slice(0, 9).padStart(10)).join(""));
  for (const a of all) console.log(a.id.slice(0, 18).padEnd(20) + all.map((b) => corrA(a, b).toFixed(2).padStart(10)).join(""));
}
main().catch((e) => { console.error(e); process.exit(1); });
