// Synthetic diversification demo (no Convex / no R2). Builds 3 PARTIALLY
// correlated strategies with similar standalone Sharpes and shows the ERC book
// Sharpe exceeds the best standalone — the core Wave-2 thesis. Also prints the
// correlation matrix, ERC weights/risk-contributions, and each strategy's
// marginal contribution. Run: npx tsx scripts/book-demo.ts

import { mulberry32 } from "../src/engine/stats";
import { buildBook, marginalContribution, bookQualifies, statsOf, type Stream } from "../src/engine/book";

function gauss(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const HOUR = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);
const PPY = 8760;
const N = 6000;
const axis = Array.from({ length: N }, (_, i) => T0 + i * HOUR);

// Two latent factors. Each strategy loads on them differently => partial
// correlation. All three target a similar standalone Sharpe (~1).
const fRng = mulberry32(2026);
const F1 = Array.from({ length: N }, () => 0.004 * gauss(fRng));
const F2 = Array.from({ length: N }, () => 0.004 * gauss(fRng));

function strat(id: string, seed: number, mean: number, b1: number, b2: number, idioVol: number): Stream {
  const r = mulberry32(seed);
  const ret = new Array<number>(N);
  for (let i = 0; i < N; i++) ret[i] = mean + b1 * F1[i] + b2 * F2[i] + idioVol * gauss(r);
  return { id, t: axis, ret };
}

function main() {
  // A: heavy F1.  B: heavy F2.  C: a blend (correlated to BOTH but not perfectly).
  const A = strat("A", 11, 0.00028, 1.0, 0.2, 0.0035);
  const B = strat("B", 22, 0.00028, 0.2, 1.0, 0.0035);
  const C = strat("C", 33, 0.00028, 0.6, 0.6, 0.0035);
  const streams = [A, B, C];
  const labels = ["A(F1)", "B(F2)", "C(mix)"];

  const standalone = streams.map((s) => statsOf(s.ret as number[], PPY).sharpe);
  const book = buildBook(streams, PPY);
  const best = Math.max(...standalone);

  console.log("===== Synthetic diversification demo: 3 partially-correlated strategies =====\n");
  console.log("standalone annualized Sharpe:");
  labels.forEach((l, i) => console.log(`   ${l}: ${standalone[i].toFixed(2)}`));
  console.log(`\ncorrelation matrix:`);
  console.log("        " + labels.map((l) => l.padStart(9)).join(""));
  book.correlation.forEach((row, r) => console.log(`   ${labels[r].padEnd(7)}` + row.map((c) => c.toFixed(2).padStart(9)).join("")));
  console.log(`   meanAbsCorr = ${book.meanAbsCorr.toFixed(2)}\n`);

  console.log("ERC (risk-parity) book:");
  book.members.forEach((m, i) => console.log(`   ${labels[i]}: weight=${(m.weight * 100).toFixed(1)}%  riskContrib=${(m.riskContrib * 100).toFixed(1)}%`));
  console.log(`   book Sharpe = ${book.stats.sharpe.toFixed(2)}   vol = ${(book.stats.vol * 100).toFixed(1)}%   maxDD = ${(book.stats.maxDD * 100).toFixed(1)}%\n`);

  console.log(`DIVERSIFICATION LIFT: book Sharpe ${book.stats.sharpe.toFixed(2)} vs best standalone ${best.toFixed(2)}  =>  ${book.stats.sharpe > best ? `+${(book.stats.sharpe - best).toFixed(2)} LIFT` : "NO lift"}\n`);

  console.log("marginal contribution (leave-one-out, vs the other two):");
  streams.forEach((s, idx) => {
    const others = streams.filter((_, j) => j !== idx);
    const mc = marginalContribution(s, others, PPY);
    const q = bookQualifies(mc, { minMarginalSharpe: 0.1, maxCorr: 0.6 });
    console.log(`   ${labels[idx]}: marginalSharpe=${mc.marginalSharpe.toFixed(2)}  maxCorr=${mc.maxCorr.toFixed(2)}  qualifies=${q ? "YES" : "no"}`);
  });

  // Compare two NEW sleeves added to the {A,B,C} book at EQUAL standalone Sharpe:
  // a redundant clone of A (corr ~1) vs a fresh independent sleeve (corr ~0).
  // The independent sleeve must add MORE book Sharpe than the redundant clone.
  console.log("\nadmission probe — same standalone Sharpe, different correlation:");
  const cloneA: Stream = { id: "A2", t: axis, ret: (A.ret as number[]).map((x) => x) };
  const mcClone = marginalContribution(cloneA, streams, PPY);
  const indRng = mulberry32(909);
  // independent sleeve: own idiosyncratic series, mean tuned to ~match A's Sharpe
  const indep: Stream = { id: "IND", t: axis, ret: Array.from({ length: N }, () => 0.00026 + 0.0035 * gauss(indRng)) };
  const mcIndep = marginalContribution(indep, streams, PPY);
  console.log(`   redundant clone of A: standalone=${mcClone.standaloneSharpe.toFixed(2)}  maxCorr=${mcClone.maxCorr.toFixed(2)}  marginalSharpe=${mcClone.marginalSharpe.toFixed(2)}`);
  console.log(`   independent sleeve  : standalone=${mcIndep.standaloneSharpe.toFixed(2)}  maxCorr=${mcIndep.maxCorr.toFixed(2)}  marginalSharpe=${mcIndep.marginalSharpe.toFixed(2)}`);
  console.log(`   => the low-corr sleeve adds ${mcIndep.marginalSharpe > mcClone.marginalSharpe ? "MORE" : "LESS"} book Sharpe than the redundant clone at equal standalone edge.`);
}

main();
