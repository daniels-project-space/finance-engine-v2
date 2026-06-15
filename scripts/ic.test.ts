// Unit tests for the WAVE-3a signal-IC research layer. Numerical acceptance
// criteria from the spec are MANDATORY and asserted here.
// Run: npx tsx scripts/ic.test.ts
//
// (a) signal engineered to perfectly LEAD forward returns -> IC ~ 1 (>0.9)
// (b) pure-noise signal -> |IC| small (<0.1) AND t-stat NOT significant (|t|<2)
// (c) orthogonality: identical signals -> corr ~ 1 ; independent -> ~ 0
// plus: rankSignals flags a duplicate as redundant; crypto-native catalog scores.

import { mulberry32 } from "../src/engine/stats";
import {
  informationCoefficient, forwardReturns, spearman, signalOrthogonality,
  rankSignals, ranks, type NamedSignal,
} from "../src/engine/ic";
import { SIGNAL_CATALOG, buildSignalMatrix } from "../src/engine/signals";
import type { Bars } from "../src/engine/types";

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

// ====================================================== (a) perfect-lead signal
function testPerfectLead() {
  console.log("— (a) perfect lead -> IC ~ 1 —");
  const rng = mulberry32(7);
  const n = 4000, horizon = 1;
  // build random forward returns first, then set signal_t := fwdReturn_t exactly.
  // signal_t leads the [t,t+1] return perfectly -> Spearman IC ~ 1.
  const closes: number[] = [1000];
  for (let i = 1; i < n + horizon + 2; i++) closes.push(Math.max(1, closes[i - 1] * (1 + 0.01 * gauss(rng))));
  const fwd = forwardReturns(closes, horizon);
  const signal = new Float64Array(closes.length);
  for (let i = 0; i < closes.length; i++) signal[i] = Number.isFinite(fwd[i]) ? fwd[i] : 0;
  const ic = informationCoefficient(signal, fwd, horizon);
  check("perfect-lead IC mean > 0.9", ic.icMean > 0.9, `icMean=${ic.icMean.toFixed(3)} pooled=${ic.pooledIC.toFixed(3)} IR=${ic.icIR.toFixed(2)} t=${ic.tStat.toFixed(1)} n=${ic.n}`);
  check("perfect-lead pooled IC > 0.9", ic.pooledIC > 0.9, `pooled=${ic.pooledIC.toFixed(3)}`);
  check("perfect-lead t-stat is significant", Math.abs(ic.tStat) > 3, `t=${ic.tStat.toFixed(1)}`);

  // a NEGATIVE perfect lead (signal = -fwd) -> IC ~ -1
  const negSig = new Float64Array(closes.length);
  for (let i = 0; i < closes.length; i++) negSig[i] = Number.isFinite(fwd[i]) ? -fwd[i] : 0;
  const icNeg = informationCoefficient(negSig, fwd, horizon);
  check("anti-lead IC mean < -0.9", icNeg.icMean < -0.9, `icMean=${icNeg.icMean.toFixed(3)}`);
}

// ====================================================== (b) pure-noise signal
function testNoise() {
  console.log("— (b) pure noise -> |IC| small + not significant —");
  // run several seeds; a noise signal independent of returns must have tiny IC
  // and an insignificant t-stat the vast majority of the time.
  let okIC = 0, okT = 0, trials = 0;
  const icMags: number[] = [], tMags: number[] = [];
  for (let seed = 1; seed <= 10; seed++) {
    const rng = mulberry32(seed * 131 + 5);
    const n = 5000, horizon = 1;
    const closes: number[] = [1000];
    for (let i = 1; i < n + 4; i++) closes.push(Math.max(1, closes[i - 1] * (1 + 0.01 * gauss(rng))));
    const fwd = forwardReturns(closes, horizon);
    // signal generated from an INDEPENDENT rng stream -> no relationship to returns
    const noiseRng = mulberry32(seed * 977 + 31);
    const sig = new Float64Array(closes.length);
    for (let i = 0; i < closes.length; i++) sig[i] = gauss(noiseRng);
    const ic = informationCoefficient(sig, fwd, horizon);
    icMags.push(Math.abs(ic.pooledIC)); tMags.push(Math.abs(ic.tStat));
    if (Math.abs(ic.pooledIC) < 0.1) okIC++;
    if (Math.abs(ic.tStat) < 2) okT++;
    trials++;
  }
  check("noise |pooled IC| < 0.1 for all seeds", okIC === trials, `${okIC}/${trials}; max|IC|=${Math.max(...icMags).toFixed(3)}`);
  check("noise t-stat NOT significant (|t|<2) for most seeds", okT >= 8, `${okT}/${trials}; max|t|=${Math.max(...tMags).toFixed(2)}`);
}

// ====================================================== (c) orthogonality
function testOrthogonality() {
  console.log("— (c) orthogonality —");
  const rng = mulberry32(42);
  const n = 3000;
  const a = new Float64Array(n), aCopy = new Float64Array(n), indep = new Float64Array(n), negA = new Float64Array(n);
  const irng = mulberry32(999);
  for (let i = 0; i < n; i++) { a[i] = gauss(rng); aCopy[i] = a[i]; negA[i] = -a[i]; indep[i] = gauss(irng); }

  check("identical signals corr ~ 1", Math.abs(spearman(Array.from(a), Array.from(aCopy)) - 1) < 1e-9, `corr=${spearman(Array.from(a), Array.from(aCopy)).toFixed(4)}`);
  check("negated signal corr ~ -1", Math.abs(spearman(Array.from(a), Array.from(negA)) + 1) < 1e-9, `corr=${spearman(Array.from(a), Array.from(negA)).toFixed(4)}`);
  const indepCorr = spearman(Array.from(a), Array.from(indep));
  check("independent signals corr ~ 0", Math.abs(indepCorr) < 0.06, `corr=${indepCorr.toFixed(4)}`);

  const orth = signalOrthogonality(a, [
    { name: "copy", values: aCopy },
    { name: "indep", values: indep },
  ]);
  check("orthogonality picks the duplicate as most-correlated", orth.mostCorrelated === "copy" && orth.maxAbsCorr > 0.99, `most=${orth.mostCorrelated} max=${orth.maxAbsCorr.toFixed(3)}`);

  // ranks: a strictly increasing series ranks 1..n; ties average
  const rk = ranks([10, 30, 20, 30]);
  check("rank ties averaged", rk[1] === 3.5 && rk[3] === 3.5 && rk[0] === 1 && rk[2] === 2, JSON.stringify(rk));
}

// ====================================================== rankSignals redundancy
function testRankRedundancy() {
  console.log("— rankSignals redundancy flag —");
  const rng = mulberry32(5);
  const n = 4000, horizon = 1;
  const closes: number[] = [1000];
  for (let i = 1; i < n + 4; i++) closes.push(Math.max(1, closes[i - 1] * (1 + 0.01 * gauss(rng))));
  const fwd = forwardReturns(closes, horizon);
  // strong predictor + an exact duplicate of it + a noise signal
  const strong = new Float64Array(closes.length);
  for (let i = 0; i < closes.length; i++) strong[i] = Number.isFinite(fwd[i]) ? fwd[i] + 0.0005 * gauss(rng) : 0;
  const dup = Float64Array.from(strong);
  const nrng = mulberry32(31);
  const noise = new Float64Array(closes.length);
  for (let i = 0; i < closes.length; i++) noise[i] = gauss(nrng);
  const sigs: NamedSignal[] = [
    { name: "strong", values: strong },
    { name: "dup_of_strong", values: dup },
    { name: "noise", values: noise },
  ];
  const res = rankSignals(sigs, closes, horizon, { redundancyCorr: 0.8 });
  const dupRank = res.ranked.find((r) => r.name === "dup_of_strong")!;
  const strongRank = res.ranked.find((r) => r.name === "strong")!;
  console.log("    ranked:", res.ranked.map((r) => `${r.name}(IR=${r.icIR.toFixed(2)},red=${r.redundant})`).join("  "));
  check("strong + dup outrank noise", res.ranked[0].name !== "noise" && res.ranked[1].name !== "noise", res.ranked.map((r) => r.name).join(","));
  check("duplicate flagged redundant with strong", dupRank.redundant && dupRank.redundantWith === "strong", `red=${dupRank.redundant} with=${dupRank.redundantWith}`);
  check("top signal NOT flagged redundant", !strongRank.redundant, `red=${strongRank.redundant}`);
}

// ====================================================== catalog evaluates
function testCatalogEvaluates() {
  console.log("— signal catalog evaluates on bars (incl. crypto-native) —");
  // synthetic bars carrying funding + spot + OI + LSR so every catalog input is exercised
  const rng = mulberry32(3);
  const n = 3000;
  const t: number[] = [], o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [], v: number[] = [], spotC: number[] = [];
  let px = 30000;
  const start = Date.UTC(2022, 0, 1);
  for (let i = 0; i < n; i++) {
    const r = 0.0003 + (rng() - 0.5) * 0.01;
    const open = px; px = Math.max(1, px * (1 + r));
    t.push(start + i * 3600_000); o.push(open); c.push(px);
    h.push(Math.max(open, px) * 1.001); l.push(Math.min(open, px) * 0.999); v.push(1000 + rng() * 5000);
    spotC.push(px * (1 - 0.0005 + rng() * 0.001)); // spot near perp -> small basis
  }
  // funding stamps every 8 bars; OI + LSR stamps every 4 bars
  const fundingT: number[] = [], fundingR: number[] = [];
  for (let i = 0; i < n; i += 8) { fundingT.push(t[i]); fundingR.push((rng() - 0.5) * 0.001); }
  const oiT: number[] = [], oiV: number[] = [], lsrT: number[] = [], lsrR: number[] = [];
  let oi = 100000;
  for (let i = 0; i < n; i += 4) { oi *= 1 + (rng() - 0.5) * 0.02; oiT.push(t[i]); oiV.push(oi); lsrT.push(t[i]); lsrR.push(0.8 + rng() * 0.6); }
  const bars: Bars = { symbol: "BTC/USDT", tf: "1h", t, o, h, l, c, v, fundingT, fundingR, spotC, oiT, oiV, lsrT, lsrR };

  const matrix = buildSignalMatrix(bars);
  const finiteCount = (a: Float64Array) => { let k = 0; for (const x of a) if (Number.isFinite(x)) k++; return k; };
  const cryptoNames = ["funding", "fundroc", "fundzscore", "fundaccel", "fundmom", "basis", "basis_zscore_96", "oi_zscore_168", "lsr_zscore_96"];
  let allCryptoLive = true;
  for (const name of cryptoNames) {
    const sgnl = matrix.find((m) => m.name === name);
    const live = !!sgnl && finiteCount(sgnl.values) > 100;
    if (!live) { allCryptoLive = false; console.error(`    crypto signal ${name} not live`); }
  }
  check(`catalog has ${SIGNAL_CATALOG.length} signals all evaluating`, matrix.length === SIGNAL_CATALOG.length);
  check("crypto-native signals produce real values on synthetic bars", allCryptoLive);
  // basis should be small and centered near 0 (perp~spot); not all zero
  const basis = matrix.find((m) => m.name === "basis")!.values;
  let any = false, maxAbs = 0;
  for (const x of basis) if (Number.isFinite(x)) { if (x !== 0) any = true; maxAbs = Math.max(maxAbs, Math.abs(x)); }
  check("basis is real, small, non-zero", any && maxAbs < 0.05, `maxAbs=${maxAbs.toFixed(4)}`);
}

function main() {
  testPerfectLead();
  testNoise();
  testOrthogonality();
  testRankRedundancy();
  testCatalogEvaluates();
  console.log(failures === 0 ? "\nALL IC TESTS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
