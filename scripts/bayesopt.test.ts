// Unit tests for the WAVE-3b Bayesian (TPE) optimizer.
// Run: npx tsx scripts/bayesopt.test.ts
//
// Acceptance criteria from the spec (MANDATORY, asserted here):
//   (a) on a multi-modal objective (shifted quadratic + Rastrigin-lite), the
//       Bayesian best-found >= random best-found at EQUAL evaluation budget
//       (and ideally reaches within X% of the optimum in far fewer evals);
//   (b) it EXPLORES before exploiting (doesn't collapse to the first sample);
//   (c) it returns the FULL evaluated-config set (for the Wave-1 PBO).

import { bayesOptimize } from "../src/engine/bayesopt";
import { mulberry32 } from "../src/engine/stats";
import type { StrategyDoc } from "../src/engine/types";

let failures = 0;
function check(name: string, cond: boolean, info = "") {
  if (cond) console.log(`  ✓ ${name}${info ? `  (${info})` : ""}`);
  else { console.error(`  ✗ ${name}  ${info}`); failures++; }
}

// A 2D search space expressed as a StrategyDoc's params (bayesOptimize reads
// doc.params for the bounds/defaults; the strategy body is irrelevant here since
// we pass our own `evaluate`).
function space2d(): StrategyDoc {
  return {
    name: "opt_space",
    hypothesis: "synthetic optimization space for the TPE unit test (>=10 chars).",
    longEntry: { op: "gt", a: { op: "price", field: "close" }, b: { op: "const", value: 0 } },
    longExit: { op: "lt", a: { op: "price", field: "close" }, b: { op: "const", value: 0 } },
    params: {
      x: { min: -10, max: 10, default: 9.0 },   // prior deliberately FAR from the optimum (~0)
      y: { min: -10, max: 10, default: -8.5 },
    },
    risk: { volTargetAnnual: 0.25, maxLeverage: 2 },
  };
}

// Rastrigin-lite (multi-modal): global max at (0,0). We MAXIMIZE, so negate the
// classic Rastrigin. Many local optima from the cosine ripples; global optimum
// value = 0 at the origin (all other points are < 0).
function rastriginNeg(p: Record<string, number>): number {
  const A = 6;
  let s = 2 * A;
  for (const v of [p.x, p.y]) s += v * v - A * Math.cos(2 * Math.PI * v);
  return -s; // max 0 at origin
}
// Shifted quadratic: smooth unimodal, global max at (3,-4), value 0.
function shiftedQuad(p: Record<string, number>): number {
  return -((p.x - 3) ** 2 + (p.y + 4) ** 2);
}

function asEval(fn: (p: Record<string, number>) => number) {
  return (params: Record<string, number>) => ({ objective: fn(params), sharpe: fn(params), trades: 100 });
}

// pure random search over the same space + budget, deterministic by seed.
function randomSearch(doc: StrategyDoc, fn: (p: Record<string, number>) => number, budget: number, seed: number) {
  const rng = mulberry32(seed);
  const specs = doc.params;
  let best = -Infinity;
  for (let t = 0; t < budget; t++) {
    const p: Record<string, number> = {};
    for (const [k, s] of Object.entries(specs)) {
      let v = s.min + (s.max - s.min) * rng();
      if (s.int) v = Math.round(v);
      p[k] = v;
    }
    best = Math.max(best, fn(p));
  }
  return best;
}

// ===================================================== (a) beats random @ budget
function testBeatsRandom() {
  console.log("— (a) Bayesian best-found >= random best-found @ equal budget —");
  const budget = 60;
  for (const [label, fn, opt] of [
    ["rastrigin-lite", rastriginNeg, 0],
    ["shifted-quadratic", shiftedQuad, 0],
  ] as [string, (p: Record<string, number>) => number, number][]) {
    // average over several seeds so the comparison isn't a single lucky draw.
    let bayesWins = 0, bayesSum = 0, randSum = 0;
    const seeds = [1, 7, 13, 23, 42, 99, 101, 1234];
    let bestBayesGap = Infinity;
    for (const seed of seeds) {
      const doc = space2d();
      const b = bayesOptimize({ doc, evaluate: asEval(fn), nTrials: budget, seed });
      const r = randomSearch(doc, fn, budget, seed + 5000);
      bayesSum += b.objective; randSum += r;
      if (b.objective >= r - 1e-9) bayesWins++;
      bestBayesGap = Math.min(bestBayesGap, Math.abs(opt - b.objective));
    }
    const bayesMean = bayesSum / seeds.length, randMean = randSum / seeds.length;
    check(`${label}: Bayesian mean >= random mean`, bayesMean >= randMean, `bayes=${bayesMean.toFixed(3)} random=${randMean.toFixed(3)} wins=${bayesWins}/${seeds.length}`);
    check(`${label}: Bayesian wins/ties majority of seeds`, bayesWins >= Math.ceil(seeds.length * 0.6), `${bayesWins}/${seeds.length}`);
    // within-X%: at best it should get close to the optimum (gap small in objective units)
    check(`${label}: reaches near the optimum on its best seed`, bestBayesGap < (label === "rastrigin-lite" ? 2.0 : 0.5), `bestGap=${bestBayesGap.toFixed(3)}`);
  }
}

// ===================================================== (b) explores before exploiting
function testExplores() {
  console.log("— (b) explores before exploiting (no first-sample collapse) —");
  const doc = space2d();
  const budget = 40;
  const b = bayesOptimize({ doc, evaluate: asEval(rastriginNeg), nTrials: budget, seed: 3 });
  const xs = b.configs.map((cf) => cf.params.x);
  const ys = b.configs.map((cf) => cf.params.y);
  const spread = (a: number[]) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
  const uniq = new Set(b.configs.map((cf) => `${cf.params.x.toFixed(3)},${cf.params.y.toFixed(3)}`)).size;
  check("explored many distinct points (no collapse)", uniq >= budget - 2, `${uniq}/${budget} distinct`);
  check("x search spread is non-trivial", spread(xs) > 1.0, `sd(x)=${spread(xs).toFixed(2)}`);
  check("y search spread is non-trivial", spread(ys) > 1.0, `sd(y)=${spread(ys).toFixed(2)}`);
  // it should also CONCENTRATE later: the back half should be tighter around the
  // best region than the front half (exploit AFTER explore).
  const half = Math.floor(budget / 2);
  const frontGap = b.configs.slice(0, half).reduce((s, cf) => s + Math.abs(0 - cf.objective), 0) / half;
  const backGap = b.configs.slice(half).reduce((s, cf) => s + Math.abs(0 - cf.objective), 0) / (budget - half);
  check("later evals concentrate nearer the optimum than early ones", backGap <= frontGap, `front=${frontGap.toFixed(2)} back=${backGap.toFixed(2)}`);
}

// ===================================================== (c) returns full config set
function testReturnsConfigs() {
  console.log("— (c) returns every evaluated config (for PBO) —");
  const doc = space2d();
  const budget = 50;
  const b = bayesOptimize({ doc, evaluate: asEval(shiftedQuad), nTrials: budget, seed: 11 });
  check("configs length == budget", b.configs.length === budget, `${b.configs.length}/${budget}`);
  check("every config has params + objective + sharpe", b.configs.every((cf) => cf.params && Number.isFinite(cf.objective) && Number.isFinite(cf.sharpe)));
  // the returned best objective is the max over configs
  const maxObj = Math.max(...b.configs.map((cf) => cf.objective));
  check("best objective == max(config objectives)", Math.abs(b.objective - maxObj) < 1e-9, `best=${b.objective.toFixed(4)} max=${maxObj.toFixed(4)}`);
  // warm start: the FIRST evaluated config is the prior (defaults), proving warm start
  check("first config is the prior (warm start)", b.configs[0].params.x === 9.0 && b.configs[0].params.y === -8.5, JSON.stringify(b.configs[0].params));
  // determinism: same seed -> same result
  const b2 = bayesOptimize({ doc: space2d(), evaluate: asEval(shiftedQuad), nTrials: budget, seed: 11 });
  check("deterministic given seed", Math.abs(b2.objective - b.objective) < 1e-9 && b2.configs.length === b.configs.length);
}

// ===================================================== (d) integer + zero-param
function testIntegerAndZeroParam() {
  console.log("— (d) integer params + zero-param edge case —");
  const intDoc: StrategyDoc = {
    name: "int_space",
    hypothesis: "integer parameter optimization edge case (>=10 chars).",
    longEntry: { op: "gt", a: { op: "price", field: "close" }, b: { op: "const", value: 0 } },
    longExit: { op: "lt", a: { op: "price", field: "close" }, b: { op: "const", value: 0 } },
    params: { n: { min: 2, max: 200, default: 180, int: true } },
    risk: { volTargetAnnual: 0.25, maxLeverage: 2 },
  };
  // max at n=50 (a single integer optimum)
  const b = bayesOptimize({ doc: intDoc, evaluate: asEval((p) => -((p.n - 50) ** 2)), nTrials: 40, seed: 5 });
  check("integer params stay integral", b.configs.every((cf) => Number.isInteger(cf.params.n)));
  check("integer search gets near n=50", Math.abs(b.params.n - 50) <= 4, `best n=${b.params.n}`);

  const zeroDoc: StrategyDoc = { ...intDoc, params: {} };
  const z = bayesOptimize({ doc: zeroDoc, evaluate: asEval(() => 1.23), nTrials: 30, seed: 1 });
  check("zero-param strategy evaluates once", z.configs.length === 1 && Math.abs(z.objective - 1.23) < 1e-9, `${z.configs.length} configs`);
}

function main() {
  testBeatsRandom();
  testExplores();
  testReturnsConfigs();
  testIntegerAndZeroParam();
  console.log(failures === 0 ? "\nALL BAYESOPT TESTS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
