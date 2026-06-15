// Wave-2 unit tests: Feature A (correlation-aware book / ERC) and Feature B
// (capacity & market-impact). MANDATORY numerical acceptance criteria from the
// spec are asserted here. Run: npx tsx scripts/book-capacity.test.ts

import { mulberry32 } from "../src/engine/stats";
import {
  correlationMatrix, ercWeights, ercFromCov, bookStats, marginalContribution, bookQualifies,
  buildBook, statsOf, type Stream,
} from "../src/engine/book";
import { computeCapacity } from "../src/engine/capacity";
import type { Bars, StrategyDoc } from "../src/engine/types";

let failures = 0;
function check(name: string, cond: boolean, info = "") {
  if (cond) console.log(`  ✓ ${name}${info ? `  (${info})` : ""}`);
  else { console.error(`  ✗ ${name}  ${info}`); failures++; }
}

function gauss(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const HOUR = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);
const axis = (n: number) => Array.from({ length: n }, (_, i) => T0 + i * HOUR);

// Build a stream with target per-bar mean/vol plus an optional shared factor for
// inducing correlation. `factor` is a common series; `beta` loads on it.
function makeStream(
  id: string, n: number, mean: number, vol: number, seed: number,
  factor?: number[], beta = 0,
): Stream {
  const rng = mulberry32(seed);
  const ret = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const idio = mean + vol * gauss(rng);
    ret[i] = beta && factor ? beta * factor[i] + idio : idio;
  }
  return { id, t: axis(n), ret };
}

// ========================================================== Feature A: book/ERC
function testBook() {
  console.log("— Feature A: correlation-aware book (ERC) —");
  const n = 4000;
  const ppy = 8760;

  // (a) DIVERSIFICATION LIFT: two ANTI-correlated mediocre strategies. Build a
  // shared factor; A loads +, B loads - on it, so corr(A,B) << 0. Each alone has
  // a modest Sharpe; the ERC book Sharpe must EXCEED the better standalone.
  {
    const fr = mulberry32(7);
    const factor = Array.from({ length: n }, () => 0.01 * gauss(fr));
    const A = makeStream("A", n, 0.00035, 0.004, 101, factor, +1);
    const B = makeStream("B", n, 0.00035, 0.004, 202, factor, -1);
    const corr = correlationMatrix([A, B]).matrix[0][1];
    const sA = statsOf(A.ret as number[], ppy).sharpe;
    const sB = statsOf(B.ret as number[], ppy).sharpe;
    const erc = ercWeights([A, B]);
    const book = bookStats([A, B], erc.weights, ppy).sharpe;
    const best = Math.max(sA, sB);
    check("anti-correlated pair has negative correlation", corr < -0.3, `corr=${corr.toFixed(2)}`);
    check("ERC book Sharpe > better standalone (diversification lift)", book > best,
      `book=${book.toFixed(2)} > max(${sA.toFixed(2)},${sB.toFixed(2)})=${best.toFixed(2)}`);
  }

  // (b) MARGINAL CONTRIBUTION: an UNCORRELATED positive strategy adds more to a
  // book than a 0.9-correlated one with IDENTICAL standalone Sharpe.
  {
    // existing book member: an idiosyncratic positive series.
    const member = makeStream("M", n, 0.0003, 0.004, 303);
    // candidate 1: uncorrelated, own idiosyncratic series, positive edge —
    // built with the SAME mean/vol target as the correlated peer below.
    const uncorr = makeStream("U", n, 0.0003, 0.004, 404);
    // candidate 2: ~0.9 correlated to the member. Construct it directly as
    //   rho * member + sqrt(1-rho^2) * idio  (same mean/vol), so corr ~= 0.9 by
    // construction and its standalone Sharpe is essentially identical to uncorr's.
    const rho = 0.9;
    const memRet = member.ret as number[];
    const idioRng = mulberry32(505);
    const corrRet = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const idio = 0.0003 + 0.004 * gauss(idioRng);
      // center the member contribution on its own mean so the blended mean stays ~0.0003
      corrRet[i] = 0.0003 + rho * (memRet[i] - 0.0003) + Math.sqrt(1 - rho * rho) * (idio - 0.0003);
    }
    const corrCand: Stream = { id: "C", t: member.t, ret: corrRet };

    const sU = statsOf(uncorr.ret as number[], ppy).sharpe;
    const sC = statsOf(corrCand.ret as number[], ppy).sharpe;
    const mU = marginalContribution(uncorr, [member], ppy);
    const mC = marginalContribution(corrCand, [member], ppy);

    check("correlated candidate really is ~0.9 corr to member", mC.maxCorr > 0.8,
      `maxCorr=${mC.maxCorr.toFixed(2)} (uncorr maxCorr=${mU.maxCorr.toFixed(2)})`);
    check("uncorrelated candidate has higher marginal contribution than 0.9-corr peer",
      mU.marginalSharpe > mC.marginalSharpe,
      `uncorr marg=${mU.marginalSharpe.toFixed(3)} (s=${sU.toFixed(2)}) vs corr marg=${mC.marginalSharpe.toFixed(3)} (s=${sC.toFixed(2)})`);
    check("bookQualifies admits the diversifier, by lift or low-corr",
      bookQualifies(mU, { minMarginalSharpe: 0.1, maxCorr: 0.6 }) === true,
      `marg=${mU.marginalSharpe.toFixed(2)} maxCorr=${mU.maxCorr.toFixed(2)}`);
  }

  // (c) ERC RISK CONTRIBUTIONS EQUAL WITHIN 1% on a 3-asset test (heterogeneous
  // vols + nonzero correlations). Solve from a known covariance matrix.
  {
    // 3 assets: vols 1, 2, 3 (arb units); pairwise corr 0.2 / 0.5 / 0.3
    const vols = [0.01, 0.02, 0.03];
    const corr = [
      [1, 0.2, 0.5],
      [0.2, 1, 0.3],
      [0.5, 0.3, 1],
    ];
    const cov = corr.map((row, i) => row.map((c, j) => c * vols[i] * vols[j]));
    const erc = ercFromCov(cov, { maxIter: 20000, tol: 1e-12 });
    const rc = erc.riskContrib;
    const spread = Math.max(...rc) - Math.min(...rc);
    check("ERC 3-asset risk contributions equal within 1%", spread < 0.01,
      `RC=[${rc.map((x) => (x * 100).toFixed(2) + "%").join(", ")}] spread=${(spread * 100).toFixed(3)}% iters=${erc.iterations} conv=${erc.converged}`);
    check("ERC weights sum to 1, all non-negative",
      Math.abs(erc.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9 && erc.weights.every((w) => w >= 0),
      `w=[${erc.weights.map((x) => x.toFixed(3)).join(", ")}]`);
  }

  // (d) empty book is well-defined (the live case)
  {
    const empty = buildBook([], 8760);
    check("empty book is well-defined", empty.members.length === 0 && empty.stats.sharpe === 0 && empty.nBars === 0);
    const first = marginalContribution(makeStream("X", 500, 0.0003, 0.004, 9), [], 8760);
    check("first candidate into empty book: marginal == standalone",
      Math.abs(first.marginalSharpe - first.standaloneSharpe) < 1e-9,
      `marg=${first.marginalSharpe.toFixed(2)} standalone=${first.standaloneSharpe.toFixed(2)}`);
  }
}

// ========================================================== Feature B: capacity
// Synthetic bars with a controllable trend + a fixed bar volume so the ADV proxy
// is well-defined. `noise` controls turnover indirectly via the strategy.
function synthBars(n: number, seed: number, trend: number, barVolBase: number): Bars {
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
    v.push(barVolBase * (0.8 + 0.4 * rng())); // base-asset volume per bar
  }
  return { symbol: "BTC/USDT", tf: "1h", t, o, h, l, c, v };
}

// a fast/slow EMA crossover (low turnover) and a fast/very-fast pair (high turnover)
function emaDoc(name: string, fastP: string, slowP: string, fastDef: number, slowDef: number): StrategyDoc {
  return {
    name, hypothesis: "x",
    longEntry: { op: "crossover", a: { op: "ema", src: { op: "price", field: "close" }, period: { op: "param", name: fastP } }, b: { op: "ema", src: { op: "price", field: "close" }, period: { op: "param", name: slowP } } },
    longExit: { op: "crossunder", a: { op: "ema", src: { op: "price", field: "close" }, period: { op: "param", name: fastP } }, b: { op: "ema", src: { op: "price", field: "close" }, period: { op: "param", name: slowP } } },
    params: { [fastP]: { min: 2, max: 80, default: fastDef, int: true }, [slowP]: { min: 10, max: 400, default: slowDef, int: true } },
    risk: { volTargetAnnual: 0.25, maxLeverage: 2 },
  };
}

function testCapacity() {
  console.log("— Feature B: capacity & market-impact —");
  const opts = { cost: { feeBps: 5, slipBps: 2 }, ppy: 8760 };
  const n = 16000;
  const bars = synthBars(n, 5, 0.0009, 50); // ~50 base units/bar * 30000 px = 1.5M notional/bar
  const range = { startI: 1, endI: n - 1 };

  // low-turnover: 20/120 EMA cross.  high-turnover: 3/8 EMA cross (flips often).
  const low = emaDoc("low_turnover", "f", "s", 20, 120);
  const high = emaDoc("high_turnover", "f", "s", 3, 8);

  const capLow = computeCapacity(low, bars, { f: 20, s: 120 }, opts, range, { k: 0.7, refAumUsd: 1e5 });
  const capHigh = computeCapacity(high, bars, { f: 3, s: 8 }, opts, range, { k: 0.7, refAumUsd: 1e5 });

  console.log(`     low : tov/yr=${capLow.turnoverPerYear.toFixed(0)} frictionless=${capLow.frictionlessSharpe.toFixed(2)} impAdj@100k=${capLow.impactAdjustedSharpe.toFixed(2)} capUsd=$${fmt(capLow.capacityUsd)} floor=${capLow.floor.toFixed(2)}`);
  console.log(`     high: tov/yr=${capHigh.turnoverPerYear.toFixed(0)} frictionless=${capHigh.frictionlessSharpe.toFixed(2)} impAdj@100k=${capHigh.impactAdjustedSharpe.toFixed(2)} capUsd=$${fmt(capHigh.capacityUsd)} floor=${capHigh.floor.toFixed(2)}`);

  check("high-turnover strategy turns over more than low-turnover",
    capHigh.turnoverPerYear > capLow.turnoverPerYear,
    `high=${capHigh.turnoverPerYear.toFixed(0)} low=${capLow.turnoverPerYear.toFixed(0)}`);

  // (a) higher-turnover strategy -> strictly LOWER capacityUsd than low-turnover.
  check("higher turnover => strictly lower capacityUsd",
    capHigh.capacityUsd < capLow.capacityUsd,
    `high cap=$${fmt(capHigh.capacityUsd)} < low cap=$${fmt(capLow.capacityUsd)}`);

  // (b) impactAdjustedSharpe <= frictionless AND monotonically decreasing in AUM.
  for (const cap of [capLow, capHigh]) {
    check(`${cap.curve.length}-pt curve: impAdj <= frictionless (${cap.frictionlessSharpe >= 0 ? "+" : "-"})`,
      cap.impactAdjustedSharpe <= cap.frictionlessSharpe + 1e-9,
      `impAdj=${cap.impactAdjustedSharpe.toFixed(3)} frictionless=${cap.frictionlessSharpe.toFixed(3)}`);
    let mono = true; let worst = "";
    for (let i = 1; i < cap.curve.length; i++) {
      if (cap.curve[i].netSharpe > cap.curve[i - 1].netSharpe + 1e-9) {
        mono = false; worst = `aum ${fmt(cap.curve[i - 1].aumUsd)}->${fmt(cap.curve[i].aumUsd)}: ${cap.curve[i - 1].netSharpe.toFixed(3)}->${cap.curve[i].netSharpe.toFixed(3)}`;
      }
    }
    check("net Sharpe monotonically non-increasing in AUM", mono, worst);
  }

  // (c) orderSize -> 0 (AUM -> 0) => impact cost -> 0 => net Sharpe -> frictionless.
  {
    const tiny = computeCapacity(low, bars, { f: 20, s: 120 }, opts, range, { k: 0.7, aumGrid: [1, 10, 100], refAumUsd: 1 });
    const atOne = tiny.curve[0];
    check("AUM->0: impact drag -> 0 (net Sharpe == frictionless)",
      Math.abs(atOne.netSharpe - tiny.frictionlessSharpe) < 1e-3 && atOne.impactDragAnnual < 1e-4,
      `net@$1=${atOne.netSharpe.toFixed(5)} frictionless=${tiny.frictionlessSharpe.toFixed(5)} dragAnn=${atOne.impactDragAnnual.toExponential(2)}`);
  }

  // (d) impact grows with k (sanity: bigger k -> lower impAdj Sharpe at same AUM)
  {
    const small = computeCapacity(high, bars, { f: 3, s: 8 }, opts, range, { k: 0.3, refAumUsd: 5e6 });
    const big = computeCapacity(high, bars, { f: 3, s: 8 }, opts, range, { k: 1.0, refAumUsd: 5e6 });
    check("larger impact coefficient k => lower impact-adjusted Sharpe",
      big.impactAdjustedSharpe <= small.impactAdjustedSharpe + 1e-9,
      `k=1.0 -> ${big.impactAdjustedSharpe.toFixed(3)}  k=0.3 -> ${small.impactAdjustedSharpe.toFixed(3)}`);
  }
}

function fmt(x: number): string {
  if (x >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(0)}k`;
  return x.toFixed(0);
}

function main() {
  testBook();
  testCapacity();
  console.log(failures === 0 ? "\nALL BOOK+CAPACITY TESTS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
