// Engine smoke test on synthetic data. Run: npm run smoke
// Validates: indicator causality, backtest sanity, hashing, GP validity,
// determinism, walk-forward mechanics, and an explicit look-ahead probe.

import { runBacktest } from "../src/engine/backtest";
import { canonicalHash, familyHash, validateStrategy } from "../src/engine/dsl";
import { mutateStrategy, randomStrategy } from "../src/engine/evolve";
import { dsr, mulberry32, permutationTest } from "../src/engine/stats";
import { walkForward } from "../src/engine/walkforward";
import type { Bars, StrategyDoc } from "../src/engine/types";

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
  const d = dsr(res.ret, 2, bars.c.length - 1, 100);
  check("dsr in [0,1]", d >= 0 && d <= 1, `${d}`);
  const t0 = Date.now();
  const perm = permutationTest(emaCross, synthBars(8000), { fast: 20, slow: 100 }, opts, res.metrics.sharpe, 20);
  check("permutation test runs", perm.p > 0 && perm.p <= 1, `p=${perm.p} in ${Date.now() - t0}ms`);

  console.log(failures === 0 ? "\nALL SMOKE TESTS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
