// VALIDATION EXPORT HARNESS (Phase 3 trust layer).
//
// Runs OUR production statistics (src/engine/stats.ts + src/engine/rigor.ts) on a
// representative battery of return streams and serializes everything the Python
// reference harness needs to recompute the SAME quantities via purgedcv/skfolio.
//
// Streams cover:
//   - SYNTHETIC of known properties: Gaussian Sharpe 0 / 1 / 2 at several N, plus
//     deliberately skewed & fat-tailed series (the PSR skew/kurt correction terms).
//   - REALISTIC messy series mimicking real candidate OOS streams: autocorrelated
//     (momentum-like), drawdown-prone, low-frequency-trade (sparse), high-kurtosis
//     crypto-like. These exercise the SAME code paths the gauntlet uses.
//
// For DSR we use the EXACT call the gauntlet makes: dsr(ret, 2, n-1, max(N,10), ppy)
// with the default annualized var-of-trials (0.25). This is the headline test of
// the units fix (varTrialsSRPerBar = varTrialsSRAnnual / ppy).
//
// No live data / no network: deterministic so the agreement report is reproducible.

import { writeFileSync } from "node:fs";
import { psr, dsr, mulberry32, normInv } from "../src/engine/stats";
import { pboFromMatrix, applyPurgeEmbargo, purgedTrainAllowed } from "../src/engine/rigor";

// ----- deterministic gaussian via Box-Muller on mulberry32 -----
function gauss(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// sample moments matching stats.ts moments() (population, /n)
function moments(r: number[]) {
  const n = r.length;
  let s = 0;
  for (const x of r) s += x;
  const mean = s / n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (const x of r) { const d = x - mean; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d; }
  m2 /= n; m3 /= n; m4 /= n;
  const sd = Math.sqrt(m2);
  return { n, mean, sd, skew: sd > 0 ? m3 / sd ** 3 : 0, kurt: sd > 0 ? m4 / sd ** 4 : 3, sr: sd > 0 ? mean / sd : 0 };
}

interface Case {
  name: string;
  kind: string;
  returns: number[];
  ppy: number;
  // PSR
  psr_benchmark: number;   // per-period SR threshold fed to psr()
  our_psr: number | null;  // null when our code guards to 0 by design (n<10 etc.) — flagged
  our_psr_guarded: boolean;
  // DSR (gauntlet call shape)
  n_trials: number;
  var_trials_sr_annual: number;
  our_dsr: number;
  our_sr_star_perbar: number; // the deflated benchmark our dsr() builds (recomputed identically here for cross-check)
  // moments we observed (so Python can confirm it parsed the same array)
  obs: { mean: number; sd: number; skew: number; kurt: number; sr: number };
}

const cases: Case[] = [];
const EULER = 0.5772156649015329;

// recompute the sr_star our dsr() uses (mirrors stats.ts exactly) for transparency
function ourSrStar(nTrials: number, ppy: number, varAnnual = 0.25): number {
  const N = Math.max(2, nTrials);
  const varPerBar = varAnnual / Math.max(1, ppy);
  return Math.sqrt(varPerBar) * ((1 - EULER) * normInv(1 - 1 / N) + EULER * normInv(1 - 1 / (N * Math.E)));
}

function addCase(name: string, kind: string, returns: number[], ppy: number, nTrials: number, psrBench = 0, varAnnual = 0.25) {
  const m = moments(returns);
  const f = Float64Array.from(returns);
  // our psr() guards to 0 for n<10 or sd<=1e-12 — record the guard explicitly
  const guarded = returns.length < 10 || m.sd <= 1e-12;
  const ourPsr = psr(f, 0, returns.length - 1, psrBench);
  const ourDsr = dsr(f, 0, returns.length - 1, Math.max(nTrials, 10), ppy, varAnnual);
  cases.push({
    name, kind, returns, ppy,
    psr_benchmark: psrBench,
    our_psr: guarded ? null : ourPsr,
    our_psr_guarded: guarded,
    n_trials: Math.max(nTrials, 10),
    var_trials_sr_annual: varAnnual,
    our_dsr: ourDsr,
    our_sr_star_perbar: ourSrStar(Math.max(nTrials, 10), ppy, varAnnual),
    obs: { mean: m.mean, sd: m.sd, skew: m.skew, kurt: m.kurt, sr: m.sr },
  });
}

const PPY_1H = 8760, PPY_1D = 365;

// 1) GAUSSIAN known-Sharpe streams: per-bar SR target -> mean = sr*sd.
// Use ppy=1d (365) and 1h (8760) to cross-check the units conversion at both.
for (const ppy of [PPY_1D, PPY_1H]) {
  for (const annSR of [0, 1, 2, 3]) {
    for (const n of [40, 250, 1000]) {
      const rng = mulberry32(0xC0FFEE ^ (annSR * 131 + n * 7 + ppy));
      const sd = 0.01;
      const perBarSR = annSR / Math.sqrt(ppy);
      const mean = perBarSR * sd;
      const r: number[] = [];
      for (let i = 0; i < n; i++) r.push(mean + sd * gauss(rng));
      // representative trial counts the gauntlet sees
      for (const N of [10, 40, 200]) addCase(`gauss_annSR${annSR}_n${n}_ppy${ppy}_N${N}`, "gaussian", r, ppy, N);
    }
  }
}

// 2) SKEWED streams (negative skew = crash risk; PSR penalizes positive skew? -
//    formula: denom = 1 - skew*sr + (k-1)/4 sr^2; negative skew RAISES denom,
//    lowers PSR — the correction we must validate).
for (const sign of [-1, 1]) {
  const rng = mulberry32(0xBADF00D ^ (sign + 5));
  const n = 500, sd = 0.012, mean = 0.0008;
  const r: number[] = [];
  for (let i = 0; i < n; i++) {
    // mix: occasional large move of the given sign -> skew + excess kurt
    let x = mean + sd * gauss(rng);
    if (rng() < 0.04) x += sign * 0.06 * Math.abs(gauss(rng));
    r.push(x);
  }
  addCase(`skew_${sign < 0 ? "neg" : "pos"}_n500_ppy${PPY_1D}`, "skewed", r, PPY_1D, 40);
}

// 3) FAT-TAILED (high kurtosis, ~zero skew) crypto-like
{
  const rng = mulberry32(0x7A11ED);
  const n = 800, sd = 0.01, mean = 0.0006;
  const r: number[] = [];
  for (let i = 0; i < n; i++) {
    let x = mean + sd * gauss(rng);
    if (rng() < 0.03) x += (rng() < 0.5 ? 1 : -1) * 0.05 * Math.abs(gauss(rng)); // symmetric jumps
    r.push(x);
  }
  addCase(`fattail_n800_ppy${PPY_1D}`, "fat_tailed", r, PPY_1D, 40);
}

// 4) AUTOCORRELATED momentum-like (AR(1)) — real candidate streams are serially
//    dependent; PSR/DSR assume iid but our gauntlet feeds these anyway, so verify
//    the NUMBER matches the canonical impl on the SAME array (both share the iid
//    assumption; this confirms identical computation, not statistical adequacy).
{
  const rng = mulberry32(0x4031);
  const n = 700, sd = 0.009;
  const r: number[] = [];
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const e = sd * gauss(rng);
    const x = 0.0005 + 0.25 * prev + e;
    r.push(x); prev = x - 0.0005;
  }
  addCase(`ar1_momentum_n700_ppy${PPY_1H}`, "autocorr", r, PPY_1H, 60);
}

// 5) SPARSE / low-trade (mostly flat with occasional active bars) — the on-chain
//    MVRV sleeve regime; many exact zeros, moderate moments.
{
  const rng = mulberry32(0x5A11ce);
  const n = 600;
  const r: number[] = [];
  for (let i = 0; i < n; i++) r.push(rng() < 0.15 ? (0.004 + 0.02 * gauss(rng)) : 0);
  addCase(`sparse_onchain_n600_ppy${PPY_1D}`, "sparse", r, PPY_1D, 25);
}

// 6) BORDERLINE near-floor stream (annual SR ~1.0-1.2 at N=40) — the exact zone
//    the units fix put the gate at; most sensitive region for any disagreement.
{
  for (const annSR of [0.9, 1.0, 1.1, 1.2, 1.5]) {
    const rng = mulberry32(0xB04DE7 ^ Math.round(annSR * 1000));
    const n = 252, sd = 0.01, ppy = PPY_1D;
    const mean = (annSR / Math.sqrt(ppy)) * sd;
    const r: number[] = [];
    for (let i = 0; i < n; i++) r.push(mean + sd * gauss(rng));
    addCase(`borderline_annSR${annSR}_n252_N40`, "borderline", r, ppy, 40);
  }
}

// 7) GUARD cases: tiny n (<10) and zero-variance — confirm our deliberate guard
//    behavior is documented as a CONVENTION (purgedcv raises; we return 0).
addCase("guard_tiny_n6", "guard", [0.01, -0.005, 0.002, 0.0, 0.008, -0.003], PPY_1D, 10);
addCase("guard_zero_var_n50", "guard", new Array(50).fill(0.001), PPY_1D, 10);

// ============================================================ PBO matrices
// Build performance matrices M[config][block] of KNOWN overfit character and run
// OUR pboFromMatrix. Python recomputes PBO from the SAME matrix via CSCV.
interface PboCase { name: string; M: number[][]; n_blocks: number; our_pbo: number; our_median_logit: number; our_nsplits: number; }
const pboCases: PboCase[] = [];

function addPbo(name: string, M: number[][]) {
  const res = pboFromMatrix(M, { capSplits: 100000, seed: 12345 });
  pboCases.push({ name, M, n_blocks: M[0].length, our_pbo: res.pbo, our_median_logit: res.medianLogit, our_nsplits: res.nSplits });
}

// (a) OVERFIT matrix: one config looks great IS by noise but is random OOS.
{
  const rng = mulberry32(0x0B0123);
  const nConfigs = 12, nBlocks = 10;
  const M: number[][] = [];
  for (let c = 0; c < nConfigs; c++) {
    const row: number[] = [];
    for (let b = 0; b < nBlocks; b++) row.push(gauss(rng)); // pure noise => high PBO ~0.5
    M.push(row);
  }
  addPbo("pbo_pure_noise_12x10", M);
}
// (b) GENUINE skill: config 0 is consistently best in every block => PBO ~0.
{
  const rng = mulberry32(0x5C111a);
  const nConfigs = 12, nBlocks = 10;
  const M: number[][] = [];
  for (let c = 0; c < nConfigs; c++) {
    const row: number[] = [];
    const edge = c === 0 ? 1.5 : 0; // config 0 has a real, persistent edge
    for (let b = 0; b < nBlocks; b++) row.push(edge + 0.3 * gauss(rng));
    M.push(row);
  }
  addPbo("pbo_genuine_skill_12x10", M);
}
// (c) MIXED: a few decent configs, moderate overfit.
{
  const rng = mulberry32(0x717ED);
  const nConfigs = 16, nBlocks = 8;
  const M: number[][] = [];
  for (let c = 0; c < nConfigs; c++) {
    const row: number[] = [];
    const edge = c < 3 ? 0.6 - 0.15 * c : 0;
    for (let b = 0; b < nBlocks; b++) row.push(edge + 0.7 * gauss(rng));
    M.push(row);
  }
  addPbo("pbo_mixed_16x8", M);
}

// ============================================================ PURGE/EMBARGO
// Export our purged train index sets for a battery of (testStart,testEnd,window,
// embargo) so Python (skfolio CombinatorialPurgedCV / purgedcv purge+embargo)
// can confirm NO train/test leakage and identical kept-index sets.
interface PurgeCase {
  name: string; total: number; testStart: number; testEnd: number; window: number; embargo: number;
  train_pool: number[]; our_kept: number[]; forbidden_lo: number; forbidden_hi: number;
}
const purgeCases: PurgeCase[] = [];
function addPurge(name: string, total: number, testStart: number, testEnd: number, window: number, embargo: number) {
  const pool: number[] = [];
  for (let i = 0; i < total; i++) pool.push(i);
  const kept = applyPurgeEmbargo(pool, testStart, testEnd, window, embargo);
  // also assert internal predicate consistency
  const pred = purgedTrainAllowed(testStart, testEnd, window, embargo);
  for (const j of kept) if (!pred(j)) throw new Error(`predicate/kept mismatch at ${j}`);
  purgeCases.push({ name, total, testStart, testEnd, window, embargo, train_pool: pool, our_kept: kept, forbidden_lo: testStart - window, forbidden_hi: testEnd + embargo });
}
addPurge("purge_mid_w50_e20", 1000, 600, 700, 50, 20);
addPurge("purge_start_w30_e10", 500, 0, 60, 30, 10);
addPurge("purge_end_w40_e25", 800, 700, 799, 40, 25);
addPurge("purge_zero_embargo_w50_e0", 1000, 400, 500, 50, 0);
addPurge("purge_big_window_w200_e50", 2000, 1000, 1200, 200, 50);

const out = {
  meta: {
    generated_at: new Date().toISOString(),
    source: "src/engine/stats.ts (psr,dsr) + src/engine/rigor.ts (pboFromMatrix,applyPurgeEmbargo)",
    note: "DSR uses the exact gauntlet call: dsr(ret,2,n-1,max(N,10),ppy) with default varTrialsSRAnnual=0.25; here from=0 over the full array (equivalent: validates the same formula).",
    psr_convention: "per-period SR, sample skew, RAW kurtosis (3=normal), (sr-sr0)*sqrt(n-1)/sqrt(1-skew*sr+(kurt-1)/4*sr^2)",
    dsr_units_fix: "varTrialsSRPerBar = varTrialsSRAnnual / ppy  (de-annualization). sr_star = sqrt(varPerBar)*[(1-g)z(1-1/N)+g z(1-1/(Ne))]",
  },
  psr_dsr_cases: cases,
  pbo_cases: pboCases,
  purge_cases: purgeCases,
};

const path = process.argv[2] ?? "validation/cases.json";
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(`wrote ${cases.length} psr/dsr cases, ${pboCases.length} pbo cases, ${purgeCases.length} purge cases -> ${path}`);
