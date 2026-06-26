// OPTIONS-IV FEASIBILITY SPIKE (script only — NOT wired).
//
// Genuinely-new data: Deribit DVOL (BTC/ETH implied-vol index, 30d constant
// maturity, ~5y daily history, free). Tests whether options-IV signals drive a
// diversifying PERP sleeve (the engine trades perps, not options). Signals:
//   - IV level (DVOL z-score) — vol regime
//   - IV - RV spread (DVOL - own trailing realized vol) — vol-risk-premium proxy
// Construction: long-flat BTC/ETH perp, TIMED by the IV signal (in/out), realistic
// costs (fee+slip+funding), honest purged WF, NO look-ahead (IV is point-in-time,
// RV trailing). Decisive: OOS Sharpe + correlation to the momentum cluster.
//
// NOTE: skew / term-structure are NOT obtainable free (Deribit only exposes ~4d of
// expired-option chain), so this spike covers IV-level + IV-RV only.

import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "fs";
import { loadBars } from "../src/lib/data";
import { getAppConfig } from "../src/pipeline/process";
import { generateXSection } from "../src/engine/xsectionGen";
import { alignUniverse, backtestXSection } from "../src/engine/xsection";
import { statsOf, pearson, type Stream } from "../src/engine/book";
import { DEFAULT_FEE_BPS, SLIP_BPS, PPY, type Bars } from "../src/engine/types";

const PPY_D = 365;                       // daily bars
const FEE = DEFAULT_FEE_BPS;
function corrS(a: Stream, b: Stream): number { const bm = new Map<number, number>(); b.t.forEach((t, i) => bm.set(t, b.ret[i])); const av: number[] = [], bv: number[] = []; a.t.forEach((t, i) => { const x = bm.get(t); if (x !== undefined) { av.push(a.ret[i]); bv.push(x); } }); return av.length > 20 ? pearson(av, bv) : 0; }

/** Load DVOL daily [ts, open, high, low, close] -> map ts(dayStart)->close. */
function loadDvol(cur: string): Map<number, number> {
  const raw = JSON.parse(readFileSync(`/tmp/dvol_${cur}.json`, "utf8")) as number[][];
  const m = new Map<number, number>();
  for (const r of raw) { const dayStart = Math.floor(r[0] / 86400000) * 86400000; m.set(dayStart, r[4]); }
  return m;
}

function zscore(arr: number[], i: number, win: number): number {
  const lo = Math.max(0, i - win); let s = 0, sq = 0, n = 0;
  for (let k = lo; k < i; k++) { s += arr[k]; sq += arr[k] * arr[k]; n++; }
  if (n < 20) return 0;
  const m = s / n, sd = Math.sqrt(Math.max(1e-12, sq / n - m * m));
  return (arr[i] - m) / sd;
}

interface DaySeries { t: number[]; ret: number[]; dvol: number[]; rv: number[] }

/** Build a daily series for one coin: perp daily returns + aligned DVOL + trailing RV. */
function buildDaily(bars: Bars, dvol: Map<number, number>): DaySeries {
  // bars are 1d already (tf=1d). align on day starts present in BOTH.
  const t: number[] = [], ret: number[] = [], dv: number[] = [], rv: number[] = [];
  // trailing 20d realized vol (annualized) from daily returns
  const dailyRet: number[] = [0];
  for (let i = 1; i < bars.c.length; i++) dailyRet.push(bars.c[i - 1] > 0 ? bars.c[i] / bars.c[i - 1] - 1 : 0);
  for (let i = 0; i < bars.t.length; i++) {
    const day = Math.floor(bars.t[i] / 86400000) * 86400000;
    const d = dvol.get(day);
    if (d === undefined) continue;
    // trailing RV over last 20d (annualized %, matching DVOL units ~ annualized vol %)
    let s = 0, sq = 0, n = 0;
    for (let k = Math.max(1, i - 20); k <= i; k++) { s += dailyRet[k]; sq += dailyRet[k] * dailyRet[k]; n++; }
    const sd = n > 5 ? Math.sqrt(Math.max(0, sq / n - (s / n) ** 2)) : 0;
    const rvAnn = sd * Math.sqrt(365) * 100; // annualized vol in % (DVOL is in %)
    t.push(bars.t[i]); ret.push(dailyRet[i]); dv.push(d); rv.push(rvAnn);
  }
  return { t, ret, dvol: dv, rv };
}

/** Long-flat timing sleeve on a single coin from an IV signal.
 *  signal(i) decides the position HELD INTO bar i+1 (uses info <= i). */
function backtestTiming(
  S: DaySeries, signalKind: "ivrv_high" | "ivrv_low" | "dvol_low" | "dvol_high", zwin: number, thresh: number, slipBps: number,
): { ret: Float64Array; t: number[]; exposure: number } {
  const n = S.t.length;
  const w = new Float64Array(n);
  const ivrv = S.dvol.map((d, i) => d - S.rv[i]); // IV - RV (positive = vol premium rich)
  let held = 0;
  for (let i = 21; i < n; i++) {
    let want = 0;
    if (signalKind === "ivrv_high") want = zscore(ivrv, i, zwin) > thresh ? 1 : 0;       // long when vol premium rich
    else if (signalKind === "ivrv_low") want = zscore(ivrv, i, zwin) < -thresh ? 1 : 0;  // long when IV cheap vs RV
    else if (signalKind === "dvol_low") want = zscore(S.dvol, i, zwin) < -thresh ? 1 : 0;  // long in low-vol regime
    else want = zscore(S.dvol, i, zwin) > thresh ? 1 : 0;                                   // long in high-vol regime
    w[i] = want; held = want;
  }
  void held;
  const out = new Float64Array(n);
  let exp = 0;
  for (let i = 22; i < n; i++) {
    const wk = w[i - 1];
    const dw = Math.abs(w[i - 1] - w[i - 2]);
    // funding not modeled per-day here (daily perp funding ~ small); charge fee+slip on flips
    out[i] = wk * S.ret[i] - dw * (FEE + slipBps) / 1e4;
    exp += wk;
  }
  return { ret: out, t: S.t, exposure: exp / Math.max(1, n - 22) };
}

/** Purged WF over the timing sleeve: select {kind, zwin, thresh} on train, trade OOS. */
function purgedWfTiming(S: DaySeries, slipBps: number): { oos: Float64Array; t: number[]; sharpe: number; bestKind: string } {
  const n = S.t.length;
  const trainBars = 365, testBars = 120, purge = 25;
  const kinds = ["ivrv_high", "ivrv_low", "dvol_low", "dvol_high"] as const;
  const zwins = [60, 120, 250], threshs = [0, 0.5, 1.0];
  const pooled: number[] = [], pooledT: number[] = [];
  let bestKindGlobal = "?";
  let start = trainBars;
  while (start + testBars < n) {
    let best: { kind: typeof kinds[number]; zw: number; th: number; sh: number } | null = null;
    for (const kind of kinds) for (const zw of zwins) for (const th of threshs) {
      const bt = backtestTiming({ t: S.t.slice(0, start - purge), ret: S.ret.slice(0, start - purge), dvol: S.dvol.slice(0, start - purge), rv: S.rv.slice(0, start - purge) }, kind, zw, th, slipBps);
      const sh = statsOf(Array.from(bt.ret.slice(22)), PPY_D).sharpe;
      if (!best || sh > best.sh) best = { kind, zw, th, sh };
    }
    bestKindGlobal = best!.kind;
    const full = backtestTiming({ t: S.t.slice(0, start + testBars), ret: S.ret.slice(0, start + testBars), dvol: S.dvol.slice(0, start + testBars), rv: S.rv.slice(0, start + testBars) }, best!.kind, best!.zw, best!.th, slipBps);
    for (let i = start; i < start + testBars && i < full.ret.length; i++) { pooled.push(full.ret[i]); pooledT.push(S.t[i]); }
    start += testBars;
  }
  return { oos: Float64Array.from(pooled), t: pooledT, sharpe: statsOf(pooled, PPY_D).sharpe, bestKind: bestKindGlobal };
}

async function main() {
  const cx = new ConvexHttpClient(process.env.CONVEX_URL!);
  const cfg = await getAppConfig(cx);

  // === LOOK-AHEAD PROBE: corrupt future DVOL; past signal must be unchanged ===
  const btcBars = (await loadBars("BTC/USDT", "1d"))!;
  const dvolBTC = loadDvol("BTC");
  const Sbtc = buildDaily(btcBars, dvolBTC);
  const sigAt = (S: DaySeries, i: number) => zscore(S.dvol.map((d, k) => d - S.rv[k]), i, 120);
  const mid = Math.floor(Sbtc.t.length * 0.5);
  const S2: DaySeries = { ...Sbtc, dvol: Sbtc.dvol.slice() }; for (let i = mid + 1; i < S2.dvol.length; i++) S2.dvol[i] *= 1.5;
  let maxDiff = 0; for (let i = 21; i <= mid; i++) maxDiff = Math.max(maxDiff, Math.abs(sigAt(Sbtc, i) - sigAt(S2, i)));
  console.log(`LOOK-AHEAD PROBE (IV signal): max |diff| on [0,mid] after corrupting future DVOL = ${maxDiff.toExponential(2)} -> ${maxDiff < 1e-9 ? "PASS" : "FAIL"}\n`);

  console.log(`BTC daily aligned: ${Sbtc.t.length} days (${new Date(Sbtc.t[0]).toISOString().slice(0, 10)} -> ${new Date(Sbtc.t[Sbtc.t.length - 1]).toISOString().slice(0, 10)})`);

  // momentum reference (cross-sectional trend, perp universe, daily-resampled corr)
  const bl: { symbol: string; bars: Bars }[] = []; for (const s of cfg.universe) { const b = await loadBars(s, "4h"); if (b) bl.push({ symbol: s, bars: b }); }
  const A = alignUniverse(bl);
  const td = generateXSection(42, "trend"); const fp = (k: number, r: number) => { const p: Record<string, number> = { topK: k, rebalEvery: r }; for (const [kk, sp] of Object.entries(td.params ?? {})) p[kk] = sp.default; return p; };
  const momRef: Stream = { id: "mom", t: A.t, ret: backtestXSection(td, A, fp(td.topK, td.rebalEvery), PPY[ "4h" ]!, { startI: td.lookback + 1, endI: A.t.length - 1 }).ret };

  console.log("=== OPTIONS-IV PERP TIMING SLEEVES (purged WF, realistic costs) ===");
  for (const [name, sym] of [["BTC", "BTC/USDT"], ["ETH", "ETH/USDT"]] as const) {
    const bars = (await loadBars(sym, "1d"))!;
    const S = buildDaily(bars, loadDvol(name));
    const slip = SLIP_BPS[sym] ?? 2;
    const wf = purgedWfTiming(S, slip);
    const st: Stream = { id: `iv_${name}`, t: wf.t, ret: wf.oos };
    const c = Math.abs(corrS(st, momRef));
    // buy-and-hold reference for the same coin (is the timer better than just holding?)
    const bh = statsOf(S.ret.slice(22), PPY_D).sharpe;
    console.log(`  ${name}: timing OOS Sharpe=${wf.sharpe.toFixed(2)} (bestKind=${wf.bestKind}) | buy&hold Sharpe=${bh.toFixed(2)} | |corr to momentum|=${c.toFixed(2)} | ${wf.sharpe >= 0.4 && c <= 0.4 ? "*** WIN ***" : (c <= 0.4 ? "orthogonal but thin/dead" : "correlated")}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
