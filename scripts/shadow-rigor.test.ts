// Unit tests for the shadow-rigor validation-honesty stats. Numerical
// acceptance criteria from the spec are MANDATORY and asserted here.
// Run: npx tsx scripts/shadow-rigor.test.ts
//
// Covered:
//   F1a PBO (CSCV): overfit noise -> PBO >= 0.4 ; persistent edge -> PBO <= 0.2
//   F1b purge: no train index inside [testStart-window, testEnd+embargo]
//   F2  stability: flat objective -> >= 0.8 ; knife-edge -> <= 0.3
//   F3  Reality Check: 50 noise candidates -> best RC p > 0.1 (most seeds);
//        inject a genuine edge -> its RC p < 0.05
//   F4  regime: low-vol-only earner -> high-vol Sharpe <= 0 + concentration flag

import { mulberry32 } from "../src/engine/stats";
import {
  pboFromMatrix, purgedTrainAllowed, applyPurgeEmbargo, paramStability, realityCheck, computePbo,
} from "../src/engine/rigor";
import { classifyRegimes, regimeBreakdown } from "../src/engine/regime";
import { runBacktest } from "../src/engine/backtest";
import type { Bars, StrategyDoc } from "../src/engine/types";

let failures = 0;
function check(name: string, cond: boolean, info = "") {
  if (cond) console.log(`  ✓ ${name}${info ? `  (${info})` : ""}`);
  else { console.error(`  ✗ ${name}  ${info}`); failures++; }
}

// gaussian via Box-Muller on a seeded rng
function gauss(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ====================================================== F1a: PBO via CSCV matrix
function testPbo() {
  console.log("— F1a PBO (CSCV) —");

  // (a) OVERFIT: many pure-noise configs, no persistent skill. M[c][b] ~ N(0,1)
  // independent. The IS-best config should land in the bottom OOS half about
  // half the time -> PBO near 0.5, must be >= 0.4.
  {
    const rng = mulberry32(12345);
    const nConfigs = 40, nBlocks = 12;
    const M: number[][] = [];
    for (let c = 0; c < nConfigs; c++) {
      const row: number[] = [];
      for (let b = 0; b < nBlocks; b++) row.push(gauss(rng));
      M.push(row);
    }
    const res = pboFromMatrix(M, { seed: 7 });
    check("overfit noise PBO >= 0.4", res.pbo >= 0.4, `pbo=${res.pbo.toFixed(3)} over ${res.nSplits} splits`);
  }

  // (b) PERSISTENT EDGE: one config is consistently better across ALL blocks.
  // Config 0 has a strong constant skill term + small noise; the rest are noise.
  // The IS-best should keep being config 0 and rank top OOS -> PBO <= 0.2.
  {
    const rng = mulberry32(999);
    const nConfigs = 40, nBlocks = 12;
    const M: number[][] = [];
    for (let c = 0; c < nConfigs; c++) {
      const skill = c === 0 ? 3.0 : 0; // config 0 dominates every block
      const row: number[] = [];
      for (let b = 0; b < nBlocks; b++) row.push(skill + 0.4 * gauss(rng));
      M.push(row);
    }
    const res = pboFromMatrix(M, { seed: 7 });
    check("persistent edge PBO <= 0.2", res.pbo <= 0.2, `pbo=${res.pbo.toFixed(3)} over ${res.nSplits} splits`);
  }
}

// ====================================================== F1b: purge correctness
function testPurge() {
  console.log("— F1b purge + embargo correctness —");
  const testStart = 5000, testEnd = 5200, window = 120, embargo = 80;
  const allowed = purgedTrainAllowed(testStart, testEnd, window, embargo);
  // forbidden zone is [testStart-window, testEnd+embargo] = [4880, 5280]
  let violation = -1;
  for (let j = 0; j < 8000; j++) {
    const inZone = j >= testStart - window && j <= testEnd + embargo;
    if (allowed(j) && inZone) { violation = j; break; }      // allowed but should be purged
    if (!allowed(j) && !inZone) { violation = -j - 1; break; } // purged but outside the zone
  }
  check("no train index inside [testStart-window, testEnd+embargo]", violation === -1, `firstViolation=${violation}`);

  // applyPurgeEmbargo drops exactly the zone from a pool
  const pool = Array.from({ length: 8000 }, (_, i) => i);
  const kept = applyPurgeEmbargo(pool, testStart, testEnd, window, embargo);
  const anyInZone = kept.some((j) => j >= testStart - window && j <= testEnd + embargo);
  check("applyPurgeEmbargo removes the whole forbidden band", !anyInZone, `kept=${kept.length}/${pool.length}`);
  // sanity: it kept everything OUTSIDE the band (no over-purging)
  const expectedKept = pool.length - ((testEnd + embargo) - (testStart - window) + 1);
  check("purge does not over-remove", kept.length === expectedKept, `kept ${kept.length} expected ${expectedKept}`);
}

// ====================================================== F2: parameter stability
// Synthetic StrategyDoc whose realized Sharpe is governed by how we wire params.
// We exploit a real backtest on synthetic bars, but pick two strategies whose
// objective surface around the base is flat vs knife-edge.
function synthBars(n: number, seed: number, trend: number): Bars {
  const rng = mulberry32(seed);
  const t: number[] = [], o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [], v: number[] = [];
  let px = 30000, drift = trend;
  const start = Date.UTC(2021, 5, 1);
  for (let i = 0; i < n; i++) {
    if (i % 1500 === 0) drift = (rng() < 0.5 ? -1 : 1) * Math.abs(trend) * (0.5 + rng());
    const ret = drift + (rng() - 0.5) * 0.012;
    const open = px; px = Math.max(1, px * (1 + ret));
    t.push(start + i * 3600_000); o.push(open); c.push(px);
    h.push(Math.max(open, px) * (1 + rng() * 0.003)); l.push(Math.min(open, px) * (1 - rng() * 0.003));
    v.push(1000 + rng() * 5000);
  }
  return { symbol: "BTC/USDT", tf: "1h", t, o, h, l, c, v };
}

function testStability() {
  console.log("— F2 parameter stability —");
  const opts = { cost: { feeBps: 5, slipBps: 2 }, ppy: 8760 };
  const bars = synthBars(4000, 5, 0.0009);
  // a 2-param doc; the injected objective decides flat vs knife-edge so the REAL
  // paramStability function (perturbation grid + combination formula) is tested.
  const doc: StrategyDoc = {
    name: "stab", hypothesis: "x",
    longEntry: { op: "gt", a: { op: "ema", src: { op: "price", field: "close" }, period: { op: "param", name: "a" } }, b: { op: "ema", src: { op: "price", field: "close" }, period: { op: "param", name: "b" } } },
    longExit: { op: "lt", a: { op: "ema", src: { op: "price", field: "close" }, period: { op: "param", name: "a" } }, b: { op: "ema", src: { op: "price", field: "close" }, period: { op: "param", name: "b" } } },
    params: { a: { min: 5, max: 80, default: 20, int: true }, b: { min: 50, max: 300, default: 100, int: true } },
    risk: { volTargetAnnual: 0.25, maxLeverage: 2 },
  };
  const base = { a: 20, b: 100 };

  // FLAT objective: Sharpe ~constant in params (small noise around 1.5).
  const flatRng = mulberry32(11);
  const flat = paramStability(doc, bars, opts, base, { startI: 1, endI: bars.c.length - 1 }, {
    sharpeFn: () => 1.5 + 0.03 * gauss(flatRng),
  });
  check("flat objective stability >= 0.8", flat.stability >= 0.8,
    `stability=${flat.stability.toFixed(2)} base=${flat.baseSharpe.toFixed(2)} frac=${flat.neighborFrac.toFixed(2)} smooth=${flat.smoothness.toFixed(2)} n=${flat.nNeighbors}`);

  // KNIFE-EDGE objective: Sharpe is high ONLY exactly at base; any perturbation
  // collapses it toward 0 / negative.
  const knife = paramStability(doc, bars, opts, base, { startI: 1, endI: bars.c.length - 1 }, {
    sharpeFn: (p) => (p.a === base.a && p.b === base.b) ? 1.6 : -0.1,
  });
  check("knife-edge objective stability <= 0.3", knife.stability <= 0.3,
    `stability=${knife.stability.toFixed(2)} base=${knife.baseSharpe.toFixed(2)} frac=${knife.neighborFrac.toFixed(2)} smooth=${knife.smoothness.toFixed(2)} n=${knife.nNeighbors}`);
}

// ====================================================== F3: Reality Check / SPA
function testRealityCheck() {
  console.log("— F3 White Reality Check / SPA —");

  // (a) 50 PURE-NOISE candidates: each is mean-zero gaussian per-bar returns.
  // The best-of-50 will look good by luck; the family-wise RC p must NOT be
  // small (controls FWER) for MOST seeds.
  {
    let pAbove = 0, trials = 0;
    const pvals: number[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const rng = mulberry32(seed * 101 + 1);
      const cands: number[][] = [];
      for (let c = 0; c < 50; c++) {
        const r: number[] = [];
        for (let i = 0; i < 500; i++) r.push(0.012 * gauss(rng)); // mean ZERO
        cands.push(r);
      }
      const rc = realityCheck(cands, { nReps: 500, seed: seed * 13 });
      pvals.push(rc.bestRcP);
      if (rc.bestRcP > 0.1) pAbove++;
      trials++;
    }
    const frac = pAbove / trials;
    check("50 noise candidates: best RC p > 0.1 for most seeds", frac >= 0.6,
      `${pAbove}/${trials} seeds; p range [${Math.min(...pvals).toFixed(2)}, ${Math.max(...pvals).toFixed(2)}]`);
  }

  // (b) inject ONE genuine edge among noise: a candidate with a real positive
  // mean. Its RC family-wise p must be < 0.05.
  {
    const rng = mulberry32(424242);
    const cands: number[][] = [];
    // 49 noise
    for (let c = 0; c < 49; c++) {
      const r: number[] = [];
      for (let i = 0; i < 500; i++) r.push(0.012 * gauss(rng));
      cands.push(r);
    }
    // 1 genuine edge: positive mean ~0.12 daily-vol-scaled Sharpe is strong
    const edge: number[] = [];
    for (let i = 0; i < 500; i++) edge.push(0.004 + 0.012 * gauss(rng));
    cands.push(edge);
    const rc = realityCheck(cands, { nReps: 1000, seed: 77 });
    const edgeP = rc.perCandidateP[rc.perCandidateP.length - 1];
    check("genuine edge: best RC p < 0.05", rc.bestRcP < 0.05, `bestRcP=${rc.bestRcP.toFixed(4)} bestIdx=${rc.bestIndex} (edge is idx 49)`);
    check("genuine edge: its family-wise p < 0.05", edgeP < 0.05, `edgeFamilyWiseP=${edgeP.toFixed(4)}`);
    check("genuine edge is the selected best", rc.bestIndex === 49, `bestIndex=${rc.bestIndex}`);
  }
}

// ====================================================== F4: regime robustness
function testRegime() {
  console.log("— F4 regime-conditional robustness —");
  // Closes alternate LOW-vol (steady uptrend) and HIGH-vol (choppy) blocks. The
  // strategy earns ONLY in low-vol bars; in high/med-vol bars it LOSES (negative
  // drift). Because low-vol blocks trend up, those bars classify as a single
  // regime (lowvol-up), concentrating the positive PnL there.
  const n = 16000;
  const rng = mulberry32(31);
  const closes: number[] = [30000];
  // long 2000-bar blocks so vol-window/trend-window lag affects only a tiny
  // transition fraction; a buffer band around boundaries is treated as "not low"
  // for the strategy so leaked transition bars never carry positive PnL.
  const block = 2000, buffer = 150;
  const inLowBlock = (i: number) => Math.floor(i / block) % 2 === 0;
  const earns = (i: number) => inLowBlock(i) && (i % block) > buffer; // skip the ramp-in band
  for (let i = 1; i < n; i++) {
    const r = inLowBlock(i) ? 0.0012 + 0.0008 * gauss(rng) : 0.03 * gauss(rng);
    closes.push(Math.max(1, closes[i - 1] * (1 + r)));
  }

  const cls = classifyRegimes(closes, { volWindow: 48, trendWindow: 96 });
  // strategy: earns in (buffered) low-vol bars; LOSES decisively elsewhere so any
  // mislabeled transition bar contributes negative, not positive, PnL.
  const ret: number[] = [];
  for (let i = 0; i < n; i++) {
    ret.push(earns(i) ? 0.0012 + 0.0004 * gauss(rng) : -0.0015 + 0.0004 * gauss(rng));
  }
  const rb = regimeBreakdown(ret, cls.labels, 8760, 30);
  console.log("    regime sharpes:", JSON.stringify(rb.sharpeByName, (_, x) => typeof x === "number" ? Number(x.toFixed(2)) : x));
  console.log(`    buckets:`, rb.buckets.map((b) => `${b.name}:n=${b.n},pnl=${b.totalPnl.toFixed(2)}`).join("  "));
  console.log(`    dominant=${rb.dominant?.name} share=${((rb.dominant?.share ?? 0) * 100).toFixed(0)}% concentration=${rb.pnlConcentration}`);

  // high-vol buckets are labels 4 (highvol-down) and 5 (highvol-up)
  const highSharpes = Object.entries(rb.sharpeByName).filter(([k]) => k.startsWith("highvol")).map(([, v]) => v);
  check("low-vol-only earner: high-vol regime Sharpe <= 0", highSharpes.length > 0 && highSharpes.every((s) => s <= 0),
    `highvol sharpes=[${highSharpes.map((s) => s.toFixed(2)).join(", ")}]`);
  check("PnL concentrated in a low-vol regime", (rb.dominant?.name ?? "").startsWith("lowvol"),
    `dominant=${rb.dominant?.name} share=${((rb.dominant?.share ?? 0) * 100).toFixed(0)}%`);
  check("concentration flag fires (>80% in one regime)", rb.pnlConcentration === true,
    `share=${((rb.dominant?.share ?? 0) * 100).toFixed(0)}%`);
}

// ====================================================== integration: computePbo on a real doc
function testPboIntegration() {
  console.log("— F1 computePbo integration (real backtest path) —");
  const opts = { cost: { feeBps: 5, slipBps: 2 }, ppy: 8760 };
  const bars = synthBars(16000, 8, 0.0007);
  const doc: StrategyDoc = {
    name: "ema", hypothesis: "x",
    longEntry: { op: "crossover", a: { op: "ema", src: { op: "price", field: "close" }, period: { op: "param", name: "fast" } }, b: { op: "ema", src: { op: "price", field: "close" }, period: { op: "param", name: "slow" } } },
    longExit: { op: "crossunder", a: { op: "ema", src: { op: "price", field: "close" }, period: { op: "param", name: "fast" } }, b: { op: "ema", src: { op: "price", field: "close" }, period: { op: "param", name: "slow" } } },
    params: { fast: { min: 5, max: 50, default: 20, int: true }, slow: { min: 60, max: 300, default: 120, int: true } },
    risk: { volTargetAnnual: 0.25, maxLeverage: 2 },
  };
  // a spread of distinct configs (as the tuner would produce)
  const rng = mulberry32(3);
  const configs = Array.from({ length: 20 }, () => ({
    fast: Math.round(5 + rng() * 45), slow: Math.round(60 + rng() * 240),
  }));
  const res = computePbo(doc, bars, opts, configs, { startI: 1, endI: bars.c.length - 1 }, { nBlocks: 10 });
  check("computePbo returns a valid probability", res.pbo >= 0 && res.pbo <= 1 && res.nSplits > 0,
    `pbo=${res.pbo.toFixed(3)} splits=${res.nSplits} blocks=${res.nBlocks} configs=${res.nConfigs}`);
  // sanity: a single backtest runs
  const bt = runBacktest(doc, bars, { fast: 20, slow: 120 }, opts);
  check("integration backtest finite", Number.isFinite(bt.metrics.sharpe));
}

function main() {
  testPbo();
  testPurge();
  testStability();
  testRealityCheck();
  testRegime();
  testPboIntegration();
  console.log(failures === 0 ? "\nALL SHADOW-RIGOR TESTS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
