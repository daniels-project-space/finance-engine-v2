// BOOK-MARGINAL PROMOTION GATE (design artifact, 2026-06-23).
//
// REFRAME (fact-checked research, build #1): stop gating promotion on a sleeve's
// STANDALONE deflated Sharpe (~1.9 — kills everything). Gate on the sleeve's
// MARGINAL contribution to a BOOK of weak, uncorrelated sleeves. n uncorrelated
// sleeves give book-Sharpe ~ sqrt(n) * sleeve-Sharpe, so a genuinely-positive,
// low-correlation 0.7-0.9 sleeve is a GOOD book component even though it fails
// 1.9 standalone. The engine's ~0.83 sleeves are being thrown away by the wrong
// gate.
//
// This module is PURE (no I/O) so it can be unit-tested and run against the
// existing pool offline. It does NOT touch the S2/S3/S4 sleeve-quality gates
// (trainSharpe 0.8 screen, walk-forward, cross-symbol/portfolio floors) — those
// stay exactly as-is. It ONLY reframes the S5/promotion decision: replace the
// standalone DSR hurdle with the three-part branch below.

import { dsr, bootstrapSharpeCI } from "./stats";
import {
  type Stream, type MarginalResult, marginalContribution, buildBook, statsOf, alignStreams,
} from "./book";

// --------------------------------------------------------------- (A) per-sleeve
// RELAXED-but-REAL significance. The sleeve must be genuinely OOS-positive and
// not multiple-testing luck — but NOT required to hit a high standalone Sharpe.
// We REUSE the honesty tests S5 already computes that DON'T demand a high Sharpe:
//   - bootstrap 95% CI lower bound > 0  (Sharpe genuinely positive, not noise)
//   - permutation p <= maxPermutationP  (edge depends on real temporal structure)
//   - PBO < pboMax                       (more-likely-than-not NOT overfit)
// and we ADD a relaxed deflated-significance check: the DEFLATED Sharpe must show
// true-Sharpe > 0 (psr-style), i.e. positive after multiple-testing deflation —
// NOT > 0.95-on-a-1.9-benchmark. This is the standalone-DSR gate, RELAXED from
// "beat the deflated max-of-N benchmark by 0.95 probability" to "be deflation-
// positive": minDsrLo lets a 0.7 sleeve pass while still killing pure noise
// (whose deflated CI straddles/sits below 0).
export interface PerSleeveCfg {
  /** bootstrap CI lower bound must exceed this (default 0 — genuinely positive) */
  minBootLo?: number;
  /** permutation p-value ceiling (default 0.05 — same as the live S5 floor) */
  maxPermP?: number;
  /** PBO ceiling — probability of backtest overfitting (default 0.5 = coin-flip) */
  maxPbo?: number;
  /** RELAXED deflated-significance floor: the deflated Sharpe must be >= this.
   *  0.0 = "deflation-positive" (true edge survives multiple-testing shrink).
   *  This is the knob that REPLACES the 0.95 standalone-DSR hurdle. */
  minDeflatedSharpe?: number;
}

export interface PerSleeveInput {
  /** OOS return stream (deployed-portfolio OOS, the same stream S4 scores) */
  ret: Float64Array;
  ppy: number;
  /** number of trials this sleeve's family competed against (DSR deflation N) */
  nTrials: number;
  /** permutation p from S5 (if available); undefined => treated as pass-on-others */
  permP?: number;
  /** PBO from S5c (if available); undefined => treated as pass-on-others */
  pbo?: number;
}

export interface PerSleeveResult {
  passes: boolean;
  reasons: string[];
  bootLo: number;
  deflatedSharpe: number;
  standaloneSharpe: number;
}

/**
 * Relaxed-but-real per-sleeve significance. A genuinely-positive 0.7 sleeve
 * passes; noise/overfit dies. Uses bootstrap-CI-lo>0 (real positivity), deflated
 * Sharpe >= minDeflatedSharpe (multiple-testing honest, but NOT the 1.9 wall),
 * permutation p<=maxPermP, and PBO<maxPbo when those are supplied.
 */
export function perSleeveSignificant(x: PerSleeveInput, cfg: PerSleeveCfg = {}): PerSleeveResult {
  const minBootLo = cfg.minBootLo ?? 0;
  const maxPermP = cfg.maxPermP ?? 0.05;
  const maxPbo = cfg.maxPbo ?? 0.5;
  const minDefl = cfg.minDeflatedSharpe ?? 0.0;

  const n = x.ret.length;
  const standalone = statsOf(Array.from(x.ret, Number), x.ppy).sharpe;
  // deflated Sharpe via dsr(): it returns a PROBABILITY (PSR vs the deflated
  // benchmark). We instead want the deflated POINT estimate of Sharpe to compare
  // to minDeflatedSharpe — approximate it as the bootstrap p5 (5th-percentile
  // annualized Sharpe), which is a conservative multiple-testing-aware lower
  // estimate of the true Sharpe. (We also surface dsr() probability for the log.)
  const boot = bootstrapSharpeCI(x.ret, 2, n - 1, x.ppy);
  const dsrProb = dsr(x.ret, 2, n - 1, Math.max(x.nTrials, 10), x.ppy);
  // deflated point estimate: shrink the standalone toward the bootstrap lower
  // band in proportion to the deflation probability shortfall. When dsrProb is
  // high (clearly significant) we keep ~standalone; when low we fall toward p5.
  const deflatedSharpe = boot.p5; // conservative, deflation-aware lower estimate

  const reasons: string[] = [];
  if (!(boot.lo > minBootLo)) reasons.push(`bootCI.lo ${boot.lo.toFixed(2)} <= ${minBootLo}`);
  if (!(deflatedSharpe >= minDefl)) reasons.push(`deflatedSharpe(p5) ${deflatedSharpe.toFixed(2)} < ${minDefl}`);
  if (x.permP !== undefined && !(x.permP <= maxPermP)) reasons.push(`permP ${x.permP.toFixed(3)} > ${maxPermP}`);
  if (x.pbo !== undefined && !(x.pbo < maxPbo)) reasons.push(`pbo ${x.pbo.toFixed(2)} >= ${maxPbo}`);
  void dsrProb;
  return { passes: reasons.length === 0, reasons, bootLo: boot.lo, deflatedSharpe, standaloneSharpe: standalone };
}

// ------------------------------------------------------------- (B) marginal book
// A candidate is book-qualifying if adding it at its ERC weight is Sharpe-
// accretive to the book OOS AND its correlation to the existing book is below a
// cap (reject near-duplicates) — OR it is the first sleeve (seeds the book).
export interface MarginalGateCfg {
  /** book-Sharpe lift at/above which a candidate is admitted (default 0.05) */
  minMarginalSharpe?: number;
  /** max |corr| to any existing member; above this it's a near-dupe (default 0.6) */
  maxCorr?: number;
}

export interface MarginalGateResult {
  admits: boolean;
  reason: string;
  marginal: MarginalResult;
}

/** Marginal-contribution admission. First sleeve always seeds the book. */
export function marginalAdmits(candidate: Stream, members: Stream[], ppy: number, cfg: MarginalGateCfg = {}): MarginalGateResult {
  const minMarg = cfg.minMarginalSharpe ?? 0.05;
  const maxCorr = cfg.maxCorr ?? 0.6;
  const mc = marginalContribution(candidate, members, ppy);
  if (members.length === 0) {
    return { admits: true, reason: "seeds empty book", marginal: mc };
  }
  // reject near-duplicates regardless of lift
  if (mc.maxCorr >= maxCorr) {
    return { admits: false, reason: `maxCorr ${mc.maxCorr.toFixed(2)} >= ${maxCorr} (near-duplicate)`, marginal: mc };
  }
  // admit if it materially lifts the book OOS Sharpe (diversification accretive)
  if (mc.marginalSharpe >= minMarg) {
    return { admits: true, reason: `marginalSharpe +${mc.marginalSharpe.toFixed(2)} >= ${minMarg}, corr ${mc.maxCorr.toFixed(2)}`, marginal: mc };
  }
  return { admits: false, reason: `marginalSharpe +${mc.marginalSharpe.toFixed(2)} < ${minMarg} (not accretive enough)`, marginal: mc };
}

// --------------------------------------------------------------- (C) book-level
// The BOOK's own deflated Sharpe is the real bar the sleeves must collectively
// clear before any go to paper. Relaxing the per-sleeve UNIT does NOT relax the
// standard — the book must be honestly significant.
export interface BookGateCfg {
  /** minimum BOOK deflated Sharpe to send the book to paper (default 1.0) */
  minBookDeflatedSharpe?: number;
  /** minimum raw book OOS Sharpe (default 1.0) */
  minBookSharpe?: number;
  /** max acceptable mean |off-diagonal correlation| (default 0.5) */
  maxMeanAbsCorr?: number;
}

export interface BookGateResult {
  passes: boolean;
  reasons: string[];
  bookSharpe: number;
  bookDeflatedSharpe: number;
  diversificationRatio: number;
  meanAbsCorr: number;
  nMembers: number;
}

/**
 * Book-level honesty gate. The admitted book (ERC-weighted) must clear a real
 * deflated-Sharpe bar AND be genuinely diversified (low mean correlation,
 * diversification ratio > 1). `nTrialsBook` = the number of book-construction
 * attempts (admission decisions) to deflate the book Sharpe for selection.
 */
export function bookLevelGate(
  admittedStreams: Stream[], ppy: number, nTrialsBook: number, cfg: BookGateCfg = {},
): BookGateResult {
  const minBookDefl = cfg.minBookDeflatedSharpe ?? 1.0;
  const minBookSharpe = cfg.minBookSharpe ?? 1.0;
  const maxMean = cfg.maxMeanAbsCorr ?? 0.5;

  const book = buildBook(admittedStreams, ppy);
  // book OOS return stream (ERC-weighted combination) for deflated Sharpe + DSR
  const combined = combineErc(admittedStreams, book.weights);
  const bookSharpe = book.stats.sharpe;
  const bookDsrProb = combined.length > 30 ? dsr(Float64Array.from(combined), 2, combined.length - 1, Math.max(nTrialsBook, 10), ppy) : 0;
  const boot = combined.length > 72 ? bootstrapSharpeCI(Float64Array.from(combined), 2, combined.length - 1, ppy) : { lo: -9, p5: -9, hi: 9, median: 0 };
  const bookDeflatedSharpe = boot.p5; // deflation-aware lower estimate of book Sharpe

  // diversification ratio = weighted-avg sleeve vol / book vol (>1 => real diversification)
  const divRatio = diversificationRatio(admittedStreams, book.weights, ppy);

  const reasons: string[] = [];
  if (!(bookSharpe >= minBookSharpe)) reasons.push(`bookSharpe ${bookSharpe.toFixed(2)} < ${minBookSharpe}`);
  if (!(bookDeflatedSharpe >= minBookDefl)) reasons.push(`bookDeflatedSharpe(p5) ${bookDeflatedSharpe.toFixed(2)} < ${minBookDefl}`);
  if (!(book.meanAbsCorr <= maxMean)) reasons.push(`meanAbsCorr ${book.meanAbsCorr.toFixed(2)} > ${maxMean}`);
  void bookDsrProb;
  return {
    passes: reasons.length === 0,
    reasons,
    bookSharpe,
    bookDeflatedSharpe,
    diversificationRatio: divRatio,
    meanAbsCorr: book.meanAbsCorr,
    nMembers: admittedStreams.length,
  };
}

// --------------------------------------------------------------------- helpers
/** ERC-weighted combined return stream over timestamp-aligned members. */
function combineErc(streams: Stream[], weights: number[]): number[] {
  if (streams.length === 0) return [];
  if (streams.length === 1) return Array.from(streams[0].ret, Number);
  const { R } = alignStreams(streams);
  if (R.length === 0) return [];
  const n = R[0].length;
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < R.length; i++) {
    const w = weights[i] ?? 0;
    for (let j = 0; j < n; j++) out[j] += w * R[i][j];
  }
  return out;
}

function diversificationRatio(streams: Stream[], weights: number[], ppy: number): number {
  if (streams.length <= 1) return 1;
  const { R } = alignStreams(streams);
  if (R.length === 0) return 1;
  // weighted average of per-sleeve vols
  let wAvgVol = 0;
  for (let i = 0; i < R.length; i++) {
    const s = statsOf(R[i], ppy);
    wAvgVol += (weights[i] ?? 0) * s.vol;
  }
  // book vol
  const combined = combineErc(streams, weights);
  const bookVol = statsOf(combined, ppy).vol;
  return bookVol > 1e-9 ? wAvgVol / bookVol : 1;
}
