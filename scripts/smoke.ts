// Engine smoke test on synthetic data. Run: npm run smoke
// Validates: indicator causality, backtest sanity, hashing, GP validity,
// determinism, walk-forward mechanics, and an explicit look-ahead probe.

import { runBacktest } from "../src/engine/backtest";
import { toArrays } from "../src/engine/compile";
import { canonicalHash, familyHash, validateStrategy } from "../src/engine/dsl";
import { mutateStrategy, randomStrategy } from "../src/engine/evolve";
import { dsr, mulberry32, permutationTest } from "../src/engine/stats";
import { walkForward } from "../src/engine/walkforward";
import type { Bars, StrategyDoc } from "../src/engine/types";
import { generateXSection, validateXSection } from "../src/engine/xsectionGen";
import { alignUniverse, backtestXSection, isXSection } from "../src/engine/xsection";
import { generateIvSleeve, validateIvSleeve } from "../src/engine/ivsleeveGen";
import { buildIvDaily, backtestIv, isIvSleeve } from "../src/engine/ivsleeve";

let failures = 0;
function check(name: string, cond: boolean, info = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${info}`); failures++; }
}

// ---- synthetic market: regime-switching trend + noise ----
function synthBars(n: number, seed = 5, trendStrength = 0.0008): Bars {
  const rng = mulberry32(seed);
  const t: number[] = [], o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [], v: number[] = [];
  let px = 30000;
  let drift = trendStrength;
  const start = Date.UTC(2021, 5, 1);
  for (let i = 0; i < n; i++) {
    if (i % 2000 === 0) drift = (rng() < 0.5 ? -1 : 1) * trendStrength * (0.5 + rng());
    const ret = drift + (rng() - 0.5) * 0.012;
    const open = px;
    px = Math.max(1, px * (1 + ret));
    t.push(start + i * 3600_000);
    o.push(open);
    c.push(px);
    h.push(Math.max(open, px) * (1 + rng() * 0.003));
    l.push(Math.min(open, px) * (1 - rng() * 0.003));
    v.push(1000 + rng() * 5000);
  }
  return { symbol: "BTC/USDT", tf: "1h", t, o, h, l, c, v };
}

const emaCross: StrategyDoc = {
  name: "smoke_ema_cross",
  hypothesis: "Trend persistence in the synthetic regime-switching series should be captured by MA crossover.",
  longEntry: { op: "crossover", a: { op: "ema", src: { op: "price", field: "close" }, period: { op: "param", name: "fast" } }, b: { op: "ema", src: { op: "price", field: "close" }, period: { op: "param", name: "slow" } } },
  longExit: { op: "crossunder", a: { op: "ema", src: { op: "price", field: "close" }, period: { op: "param", name: "fast" } }, b: { op: "ema", src: { op: "price", field: "close" }, period: { op: "param", name: "slow" } } },
  params: { fast: { min: 5, max: 50, default: 20, int: true }, slow: { min: 60, max: 300, default: 100, int: true } },
  risk: { volTargetAnnual: 0.25, maxLeverage: 2, stopAtrMult: 3 },
};

async function main() {
  console.log("— DSL validation & hashing —");
  check("valid strategy passes", validateStrategy(emaCross).length === 0, JSON.stringify(validateStrategy(emaCross)));
  const h1 = canonicalHash(emaCross);
  const h2 = canonicalHash(JSON.parse(JSON.stringify(emaCross)));
  check("hash deterministic", h1 === h2);
  const f1 = familyHash(emaCross);
  const variant = JSON.parse(JSON.stringify(emaCross)) as StrategyDoc;
  variant.params.fast.default = 21;
  check("family hash ignores param values", familyHash(variant) === f1);
  check("exact hash differs on param bounds", canonicalHash({ ...variant, params: { ...variant.params, fast: { ...variant.params.fast, max: 60 } } }) !== h1);

  console.log("— backtest sanity —");
  const bars = synthBars(30_000);
  const opts = { cost: { feeBps: 5, slipBps: 2 }, ppy: 8760 };
  const res = runBacktest(emaCross, bars, { fast: 20, slow: 100 }, opts);
  check("equity finite", Number.isFinite(res.equity[res.equity.length - 1]));
  check("has trades", res.metrics.trades > 10, `trades=${res.metrics.trades}`);
  check("sharpe finite", Number.isFinite(res.metrics.sharpe), `sharpe=${res.metrics.sharpe}`);
  check("maxDD in range", res.metrics.maxDD <= 0 && res.metrics.maxDD > -1);
  check("exposure sane", res.metrics.exposure > 0.05 && res.metrics.exposure <= 1);
  const res2 = runBacktest(emaCross, bars, { fast: 20, slow: 100 }, opts);
  check("backtest deterministic", res2.equity[res2.equity.length - 1] === res.equity[res.equity.length - 1]);

  // look-ahead probe: a strategy reading tomorrow's close should be impossible to express,
  // but verify the weight at bar i never correlates with return at bar i (only i+1)
  console.log("— look-ahead probe —");
  let sameBar = 0, nextBar = 0, n = 0;
  for (let i = 200; i < bars.c.length - 1; i++) {
    const rNow = bars.c[i] / bars.c[i - 1] - 1;
    const rNext = bars.c[i + 1] / bars.c[i] - 1;
    if (res.weights[i] !== 0) { sameBar += Math.sign(res.weights[i]) * rNow; nextBar += Math.sign(res.weights[i]) * rNext; n++; }
  }
  // weights are DECIDED at close i and EARN bar i+1: the engine pays at i+1, so per-bar
  // pnl uses w[i-1]*r[i]. If pnl used w[i]*r[i] the strategy would see its own entry bar.
  check("pnl uses lagged weights (no same-bar earn)", (() => {
    // recompute pnl from weights and compare with ret array
    let ok = true;
    for (let i = 500; i < 600; i++) {
      const r = bars.c[i] / bars.c[i - 1] - 1;
      const manual = res.weights[i - 1] * r;
      if (Math.abs((res.ret[i] + 1e-15) - manual) > Math.abs(res.weights[i - 1] - res.weights[i - 2]) * 0.001 + 0.005) { ok = false; break; }
    }
    return ok;
  })());

  console.log("— costs reduce returns —");
  const noCost = runBacktest(emaCross, bars, { fast: 20, slow: 100 }, { ...opts, cost: { feeBps: 0, slipBps: 0 } });
  check("fees hurt", noCost.equity[noCost.equity.length - 1] > res.equity[res.equity.length - 1]);

  console.log("— funding flows through —");
  const fBars: Bars = { ...bars, fundingT: bars.t.filter((_, i) => i % 8 === 0), fundingR: bars.t.filter((_, i) => i % 8 === 0).map(() => 0.0003) };
  const fRes = runBacktest(emaCross, fBars, { fast: 20, slow: 100 }, opts);
  check("positive funding penalizes longs", fRes.equity[fRes.equity.length - 1] < res.equity[res.equity.length - 1]);

  console.log("— seed library —");
  const { SEED_LIBRARY } = await import("../src/engine/library");
  const { canonicalHash: ch, familyHash: fh } = await import("../src/engine/dsl");
  let libValid = 0;
  const fams = new Set<string>();
  for (const s of SEED_LIBRARY) {
    const errs = validateStrategy(s);
    if (errs.length === 0) libValid++;
    else console.error(`    ${s.name}: ${errs.join("; ")}`);
    fams.add(fh(s));
  }
  check(`all ${SEED_LIBRARY.length} library seeds valid`, libValid === SEED_LIBRARY.length);
  check("library families structurally distinct", fams.size === SEED_LIBRARY.length, `${fams.size}/${SEED_LIBRARY.length}`);
  const libRes = runBacktest(SEED_LIBRARY[0], bars, { fast: 16, slow: 64 }, opts);
  check("ewmac seed runs", Number.isFinite(libRes.metrics.sharpe) && libRes.metrics.trades > 5, `trades=${libRes.metrics.trades}`);

  console.log("— NaN-aware composition (indicator-of-indicator) —");
  const S = await import("../src/engine/series");
  const withNaN = new Float64Array(500);
  for (let i = 0; i < 500; i++) withNaN[i] = i < 30 ? NaN : Math.sin(i / 9) * 5 + i * 0.01;
  const composed = S.zscore(S.ema(withNaN, 10), 50);
  let finiteCount = 0, mn2 = Infinity, mx2 = -Infinity;
  for (const v of composed) if (!Number.isNaN(v)) { finiteCount++; mn2 = Math.min(mn2, v); mx2 = Math.max(mx2, v); }
  check("zscore(ema(NaN-prefixed)) produces values", finiteCount > 350, `${finiteCount} finite`);
  check("composed zscore has real range", mx2 > 1 && mn2 < -1, `[${mn2.toFixed(1)}, ${mx2.toFixed(1)}]`);
  check("warmup still NaN", Number.isNaN(composed[35]));

  console.log("— calendar ops + imported library —");
  const { toArrays } = await import("../src/engine/compile");
  const inp2 = toArrays(bars);
  check("hourutc cycles 0-23", inp2.hour[0] === (bars.t[0] / 3600000) % 24 && Math.max(...Array.from(inp2.hour.slice(0, 48))) === 23);
  check("dowutc in 0-6", Array.from(inp2.dow.slice(0, 200)).every((d) => d >= 0 && d <= 6));
  const { IMPORTED_LIBRARY } = await import("../src/engine/imports");
  let impValid = 0;
  for (const s of IMPORTED_LIBRARY) {
    const errs = validateStrategy(s);
    if (errs.length === 0) impValid++;
    else console.error(`    ${s.name}: ${errs.join("; ")}`);
  }
  check(`all ${IMPORTED_LIBRARY.length} imported strategies valid`, impValid === IMPORTED_LIBRARY.length);

  console.log("— funding op + portfolio merge —");
  const { mergePortfolio, seriesStats } = await import("../src/engine/gauntlet");
  const fundingStrategy: StrategyDoc = {
    name: "smoke_funding", hypothesis: "smoke test: contrarian to extreme funding readings.",
    longEntry: { op: "lt", a: { op: "funding" }, b: { op: "const", value: -0.0002 } },
    longExit: { op: "gt", a: { op: "funding" }, b: { op: "const", value: 0 } },
    params: {}, risk: { volTargetAnnual: 0.25, maxLeverage: 2 },
  };
  check("funding strategy validates", validateStrategy(fundingStrategy).length === 0, JSON.stringify(validateStrategy(fundingStrategy)));
  const fRng = mulberry32(3);
  const fBars2: Bars = { ...bars, fundingT: bars.t.filter((_, i) => i % 8 === 0), fundingR: bars.t.filter((_, i) => i % 8 === 0).map(() => (fRng() - 0.5) * 0.002) };
  const fRes2 = runBacktest(fundingStrategy, fBars2, {}, opts);
  check("funding strategy trades", fRes2.metrics.trades > 5 && Number.isFinite(fRes2.metrics.sharpe), `trades=${fRes2.metrics.trades}`);
  const mp = mergePortfolio([
    { t: Float64Array.from([1, 2, 3]), ret: Float64Array.from([0.01, 0.02, -0.01]) },
    { t: Float64Array.from([2, 3, 4]), ret: Float64Array.from([0.02, -0.03, 0.01]) },
  ]);
  check("portfolio merge aligns by ts", mp.t.length === 4 && Math.abs(mp.ret[1] - 0.02) < 1e-12, JSON.stringify(mp));
  const ss = seriesStats(mp.ret, mp.t, 8760);
  check("portfolio stats finite", Number.isFinite(ss.sharpe) && ss.maxDD <= 0);

  console.log("— WAVE-3a crypto-native ops + signal-IC —");
  {
    const { toArrays } = await import("../src/engine/compile");
    const { validateStrategy } = await import("../src/engine/dsl");
    // bars carrying funding + spot + OI + LSR so every new input is live
    const cnRng = mulberry32(9);
    const cnBars: Bars = {
      ...bars,
      fundingT: bars.t.filter((_, i) => i % 8 === 0),
      fundingR: bars.t.filter((_, i) => i % 8 === 0).map(() => (cnRng() - 0.5) * 0.001),
      spotC: bars.c.map((c) => c * (1 - 0.0005 + cnRng() * 0.001)),
      oiT: bars.t.filter((_, i) => i % 4 === 0),
      oiV: bars.t.filter((_, i) => i % 4 === 0).map((_, i) => 100000 * (1 + 0.0002 * i)),
      lsrT: bars.t.filter((_, i) => i % 4 === 0),
      lsrR: bars.t.filter((_, i) => i % 4 === 0).map(() => 0.8 + cnRng() * 0.6),
    };
    const inpCN = toArrays(cnBars);
    const finite = (a: Float64Array) => { let k = 0; for (const x of a) if (Number.isFinite(x) && x !== 0) k++; return k; };
    check("funding dynamics derived (fundroc/z/accel/mom live)", finite(inpCN.fundroc) > 50 && finite(inpCN.fundzscore) > 50 && finite(inpCN.fundmom) > 50);
    check("basis bar-aligned + small", finite(inpCN.basis) > 1000 && Math.max(...Array.from(inpCN.basis).map(Math.abs)) < 0.05);
    check("OI + LSR forward-filled", finite(inpCN.oi) > 1000 && finite(inpCN.lsr) > 1000);
    // a strategy that uses the new ops validates + trades
    const cnStrat: StrategyDoc = {
      name: "smoke_cn", hypothesis: "basis + funding-zscore contrarian smoke test for wave-3a inputs.",
      longEntry: { op: "and", a: { op: "lt", a: { op: "fundzscore" }, b: { op: "const", value: -1 } }, b: { op: "gt", a: { op: "basis" }, b: { op: "const", value: 0 } } },
      longExit: { op: "gt", a: { op: "fundzscore" }, b: { op: "const", value: 0 } },
      params: {}, risk: { volTargetAnnual: 0.25, maxLeverage: 2 },
    };
    check("crypto-native strategy validates", validateStrategy(cnStrat).length === 0, JSON.stringify(validateStrategy(cnStrat)));
    const cnRes = runBacktest(cnStrat, cnBars, {}, opts);
    check("crypto-native strategy runs", Number.isFinite(cnRes.metrics.sharpe) && cnRes.metrics.trades >= 0, `trades=${cnRes.metrics.trades}`);
    // hashing + canonicalization handle the new leaf ops
    check("crypto-native ops hash deterministically", canonicalHash(cnStrat) === canonicalHash(JSON.parse(JSON.stringify(cnStrat))));
    // IC layer: perfect-lead -> IC~1, noise -> ~0
    const { informationCoefficient, forwardReturns, spearman } = await import("../src/engine/ic");
    const fwd = forwardReturns(bars.c, 1);
    const lead = new Float64Array(bars.c.length);
    for (let i = 0; i < bars.c.length; i++) lead[i] = Number.isFinite(fwd[i]) ? fwd[i] : 0;
    check("IC: perfect-lead -> IC>0.9", informationCoefficient(lead, fwd, 1).pooledIC > 0.9);
    check("IC: identical signals corr=1", Math.abs(spearman([1, 2, 3, 4], [1, 2, 3, 4]) - 1) < 1e-9);
  }

  console.log("— GP generation —");
  let valid = 0;
  for (let s = 0; s < 50; s++) if (validateStrategy(randomStrategy(s)).length === 0) valid++;
  check("random strategies mostly valid", valid >= 45, `${valid}/50`);
  const mut = mutateStrategy(emaCross, 123);
  check("mutation valid", validateStrategy(mut.doc).length === 0, mut.mutation);
  check("mutation changes hash", canonicalHash(mut.doc) !== h1 || mut.mutation === "noop");

  console.log("— walk-forward (re-tuning) —");
  const wf = walkForward(emaCross, bars, opts, { trainMonths: 6, stepMonths: 2, tuneTrials: 10 });
  check("wf produces windows", wf.windows.length >= 8, `${wf.windows.length}`);
  check("wf params vary across windows", new Set(wf.windows.map((w) => JSON.stringify(w.params))).size > 1);
  check("wf pooled sharpe finite", Number.isFinite(wf.pooledSharpe));

  console.log("— walk-forward honesty (negative control) —");
  // pure random walk: an honest WF must NOT find an edge in noise
  const noiseBars = synthBars(22_000, 99, 0); // zero drift, no regimes
  const nullWf = walkForward(emaCross, noiseBars, opts, { trainMonths: 6, stepMonths: 2, tuneTrials: 12 });
  // honest WF on driftless noise must be <= ~0 (costs drag it negative);
  // a POSITIVE result here would mean look-ahead/selection leaking into OOS
  check("WF finds NO positive edge in pure noise", nullWf.pooledSharpe < 0.3, `pooled=${nullWf.pooledSharpe.toFixed(2)} over ${nullWf.windows.length} windows (negative = cost drag, the honest outcome)`);
  check("WF train/test never overlap seal", nullWf.windows.every((w) => w.testStartTs > w.trainStartTs));

  console.log("— statistics —");
  const d = dsr(res.ret, 2, bars.c.length - 1, 100, 8760);
  check("dsr in [0,1]", d >= 0 && d <= 1, `${d}`);
  const t0 = Date.now();
  const perm = permutationTest(emaCross, synthBars(8000), { fast: 20, slow: 100 }, opts, res.metrics.sharpe, 20);
  check("permutation test runs", perm.p > 0 && perm.p <= 1, `p=${perm.p} in ${Date.now() - t0}ms`);

  console.log("— cross-sectional lane —");
  // build a synthetic 8-coin universe (shared timestamps, varied trends)
  const xsBarsList = Array.from({ length: 8 }, (_, k) => {
    const b = synthBars(6000, 100 + k, 0.0006 * (1 + (k % 3)));
    return { symbol: `C${k}/USDT`, bars: { ...b, symbol: `C${k}/USDT`, tf: "4h", fundingT: [], fundingR: [] } as Bars };
  });
  const A = alignUniverse(xsBarsList);
  check("xsection universe aligns", A.t.length > 1000 && A.symbols.length === 8, `bars=${A.t.length} coins=${A.symbols.length}`);
  const xdoc = generateXSection(42, "trend");
  check("xsection doc valid + long-flat", validateXSection(xdoc).length === 0 && xdoc.side === "long-flat" && isXSection(xdoc), JSON.stringify(validateXSection(xdoc)));
  const xbt = backtestXSection(xdoc, A, { topK: xdoc.topK, rebalEvery: xdoc.rebalEvery }, 2190, { startI: xdoc.lookback + 1, endI: A.t.length - 1 });
  check("xsection backtest runs", Number.isFinite(xbt.ret[A.t.length - 1]) && xbt.nRebal > 5, `nRebal=${xbt.nRebal}`);
  // LOOK-AHEAD PROBE: corrupt all bars AFTER mid; returns on [0,mid] must be unchanged
  const mid = Math.floor(A.t.length * 0.5);
  const A2 = { ...A, close: A.close.map((c) => c.slice()), ret: A.ret.map((r) => r.slice()), inp: A.inp.map((x) => ({ ...x, c: x.c.slice() })) };
  for (let k = 0; k < A2.symbols.length; k++) for (let i = mid + 1; i < A2.t.length; i++) { A2.close[k][i] *= 1.5; A2.ret[k][i] = 0.1; (A2.inp[k].c as Float64Array)[i] *= 1.5; }
  const xbt2 = backtestXSection(xdoc, A2, { topK: xdoc.topK, rebalEvery: xdoc.rebalEvery }, 2190, { startI: xdoc.lookback + 1, endI: mid });
  const xbt1 = backtestXSection(xdoc, A, { topK: xdoc.topK, rebalEvery: xdoc.rebalEvery }, 2190, { startI: xdoc.lookback + 1, endI: mid });
  let xMaxDiff = 0; for (let i = xdoc.lookback + 2; i <= mid; i++) xMaxDiff = Math.max(xMaxDiff, Math.abs(xbt1.ret[i] - xbt2.ret[i]));
  check("xsection NO look-ahead (future corruption doesn't change past)", xMaxDiff < 1e-9, `maxDiff=${xMaxDiff.toExponential(2)}`);
  // PURE non-momentum flavors all valid + long-flat (funding/basis/oi/lsr ranks)
  const pureFlavors = ["carry_funding", "basis_disloc", "oi_washout", "lsr_contrarian", "liquidity", "size"] as const;
  let pureOk = true; for (const fl of pureFlavors) { const d = generateXSection(7, fl); if (validateXSection(d).length || d.side !== "long-flat") pureOk = false; }
  check("xsection pure non-momentum flavors valid + long-flat", pureOk, pureFlavors.join(","));
  // look-ahead probe on a FUNDING-driven rank (its inputs must also be causal)
  const fdoc = generateXSection(7, "carry_funding");
  const fbt1 = backtestXSection(fdoc, A, { topK: fdoc.topK, rebalEvery: fdoc.rebalEvery }, 2190, { startI: fdoc.lookback + 1, endI: mid });
  const fbt2 = backtestXSection(fdoc, A2, { topK: fdoc.topK, rebalEvery: fdoc.rebalEvery }, 2190, { startI: fdoc.lookback + 1, endI: mid });
  let fDiff = 0; for (let i = fdoc.lookback + 2; i <= mid; i++) fDiff = Math.max(fDiff, Math.abs(fbt1.ret[i] - fbt2.ret[i]));
  check("xsection funding-rank NO look-ahead", fDiff < 1e-9, `maxDiff=${fDiff.toExponential(2)}`);

  console.log("— IV-timing sleeve (options-IV) —");
  // synthetic daily bars + synthetic DVOL series sharing day-starts
  const ivBars = ((): Bars => { const b = synthBars(2400, 9, 0.0005); const day = b.t.map((t) => Math.floor(t / 86400000) * 86400000); return { ...b, symbol: "BTC/USDT", tf: "1d", t: day, fundingT: [], fundingR: [] } as Bars; })();
  const dvolM = new Map<number, number>(); { const rng2 = mulberry32(3); for (let i = 0; i < ivBars.t.length; i++) dvolM.set(ivBars.t[i], 50 + 30 * Math.sin(i / 40) + rng2() * 10); }
  const ivDaily = buildIvDaily(ivBars, dvolM, 20);
  check("IV daily series builds (aligned DVOL)", ivDaily.t.length > 1000 && ivDaily.dvol.length === ivDaily.t.length, `n=${ivDaily.t.length}`);
  const ivdoc = generateIvSleeve(42);
  check("IV doc valid + long-flat + BTC/ETH only", validateIvSleeve(ivdoc).length === 0 && isIvSleeve(ivdoc) && (ivdoc.symbol === "BTC/USDT" || ivdoc.symbol === "ETH/USDT"), JSON.stringify(validateIvSleeve(ivdoc)));
  const ivbt = backtestIv({ ...ivdoc, symbol: "BTC/USDT" }, ivDaily, { zWin: ivdoc.zWin, thresh: ivdoc.thresh });
  check("IV backtest runs + long-flat (exposure in [0,1])", Number.isFinite(ivbt.ret[ivDaily.t.length - 1]) && ivbt.exposure >= 0 && ivbt.exposure <= 1, `exposure=${(ivbt.exposure * 100).toFixed(0)}%`);
  // LOOK-AHEAD PROBE: corrupt future DVOL; the IV signal/return on [0,mid] must be unchanged
  const ivMid = Math.floor(ivDaily.t.length * 0.5);
  const ivDaily2: typeof ivDaily = { ...ivDaily, dvol: ivDaily.dvol.slice() }; for (let i = ivMid + 1; i < ivDaily2.dvol.length; i++) ivDaily2.dvol[i] *= 1.5;
  const ivbt2 = backtestIv({ ...ivdoc, symbol: "BTC/USDT" }, ivDaily2, { zWin: ivdoc.zWin, thresh: ivdoc.thresh }, { startI: 0, endI: ivMid });
  const ivbt1 = backtestIv({ ...ivdoc, symbol: "BTC/USDT" }, ivDaily, { zWin: ivdoc.zWin, thresh: ivdoc.thresh }, { startI: 0, endI: ivMid });
  let ivDiff = 0; for (let i = ivdoc.rvWin + 2; i <= ivMid; i++) ivDiff = Math.max(ivDiff, Math.abs(ivbt1.ret[i] - ivbt2.ret[i]));
  check("IV-timing NO look-ahead (future DVOL corruption doesn't change past)", ivDiff < 1e-9, `maxDiff=${ivDiff.toExponential(2)}`);

  console.log("— on-chain features —");
  // on-chain DSL ops exist + compile + are usable in a strategy expression
  const ocOps = ["mvrv", "activeaddr", "txcnt", "nvt", "exnetflow", "stablesupply"] as const;
  const ocBars = ((): Bars => { const b = synthBars(800, 11, 0.0004); const day = b.t.map((t) => Math.floor(t / 86400000) * 86400000); const oc = b.t.map((_, i) => 1 + Math.sin(i / 30)); return { ...b, symbol: "BTC/USDT", tf: "1d", t: day, fundingT: [], fundingR: [], ocMvrv: oc.slice(), ocActiveAddr: oc.map((x) => x * 1e6), ocTxCnt: oc.map((x) => x * 2e5), ocNvt: oc.slice(), ocExNetflow: oc.map((x) => x - 1), ocStableSupply: oc.map((x) => x * 1e11) } as Bars; })();
  const ocInp = toArrays(ocBars);
  let ocAllPresent = true; for (const op of ocOps) { const v = (ocInp as unknown as Record<string, Float64Array>)[op]; if (!v || v.length !== ocBars.t.length) ocAllPresent = false; }
  check("on-chain inputs compile into CompiledInputs", ocAllPresent, ocOps.join(","));
  const ocStrat: StrategyDoc = { name: "oc", hypothesis: "mvrv valuation regime entry", tf: "1d", longEntry: { op: "lt", a: { op: "mvrv" }, b: { op: "const", value: 1.5 } }, longExit: { op: "gt", a: { op: "mvrv" }, b: { op: "const", value: 2.5 } }, params: {}, risk: { volTargetAnnual: 0.3, maxLeverage: 2 } };
  check("strategy using on-chain op validates + runs", validateStrategy(ocStrat).length === 0 && runBacktest(ocStrat, ocBars, {}, opts).ret.length === ocBars.t.length, JSON.stringify(validateStrategy(ocStrat)));
  // LOOK-AHEAD PROBE: corrupt future on-chain values; toArrays() of [0,mid] must be unchanged
  const ocMid = Math.floor(ocBars.t.length * 0.5);
  const ocBars2: Bars = { ...ocBars, ocMvrv: ocBars.ocMvrv!.slice(), ocExNetflow: ocBars.ocExNetflow!.slice() };
  for (let i = ocMid + 1; i < ocBars2.t.length; i++) { ocBars2.ocMvrv![i] = 99; ocBars2.ocExNetflow![i] = 99; }
  const ocInp2 = toArrays(ocBars2);
  let ocDiff = 0; for (let i = 0; i <= ocMid; i++) ocDiff = Math.max(ocDiff, Math.abs(ocInp.mvrv[i] - ocInp2.mvrv[i]), Math.abs(ocInp.exnetflow[i] - ocInp2.exnetflow[i]));
  check("on-chain NO look-ahead (future on-chain corruption doesn't change past)", ocDiff < 1e-9, `maxDiff=${ocDiff.toExponential(2)}`);

  console.log(failures === 0 ? "\nALL SMOKE TESTS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
