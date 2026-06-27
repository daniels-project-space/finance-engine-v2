// MONTE CARLO robustness test — stationary-bootstrap resampling of a strategy's
// return stream. The single historical path is ONE draw from a noisy process; its
// realized max-drawdown / terminal return are point estimates that flatter or scare
// by luck of sequencing. This builds thousands of alternative histories by resampling
// the returns in geometrically-distributed BLOCKS (Politis-Romano stationary
// bootstrap) — which preserves the serial structure (momentum, vol-clustering, the
// way losing days cluster into drawdowns) that a naive IID shuffle destroys and that
// drawdown depends on entirely. The output is a DISTRIBUTION: the median outcome, the
// bad-but-plausible tail (5th percentile), and the probability of a loss or of a
// drawdown worse than a threshold. It answers "what should I actually be prepared for"
// rather than "what happened to occur once".
//
// HONEST LIMITS: the bootstrap assumes the future is a reshuffling of the SAME return
// distribution (stationarity). It captures SEQUENCE / path risk and gives a realistic
// drawdown distribution, but it cannot invent a regime or a tail event larger than
// anything already in the sample — so the tail it shows is a FLOOR on real tail risk,
// not a ceiling. Deterministic given the seed. Pure; no engine/IO touch.

import { mulberry32 } from "./stats";

export interface McPctl { p5: number; p25: number; p50: number; p75: number; p95: number; p99: number }

export interface McResult {
  n: number;              // number of simulated histories
  blockMean: number;      // mean bootstrap block length (bars)
  bars: number;           // length of the source return stream
  ppy: number;            // bars per year (annualization)
  finalMult: McPctl;      // terminal growth-of-$1 across sims
  maxDD: McPctl;          // worst drawdown (negative) across sims — p5 = the 1-in-20 bad case
  sharpe: McPctl;
  calmar: McPctl;
  pLoss: number;          // P(final < 1) — probability of a net loss over the horizon
  pDDworse: Record<string, number>;  // P(maxDD < threshold) for each threshold (e.g. "-40%")
  histFinalMult: number;  // the single realized path, for reference
  histMaxDD: number;
  histSharpe: number;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}
const P = (arr: number[]): McPctl => {
  const s = [...arr].sort((a, b) => a - b);
  return { p5: percentile(s, 5), p25: percentile(s, 25), p50: percentile(s, 50), p75: percentile(s, 75), p95: percentile(s, 95), p99: percentile(s, 99) };
};

function pathStats(rets: number[], ppy: number): { finalMult: number; maxDD: number; sharpe: number; calmar: number } {
  let eq = 1, peak = 1, dd = 0, s = 0, sq = 0;
  for (const r of rets) { eq *= 1 + r; if (eq > peak) peak = eq; const d = eq / peak - 1; if (d < dd) dd = d; s += r; sq += r * r; }
  const n = rets.length || 1, mean = s / n, sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
  const sharpe = sd > 1e-12 ? (mean / sd) * Math.sqrt(ppy) : 0;
  const years = n / ppy, cagr = eq > 0 ? Math.pow(eq, 1 / Math.max(0.01, years)) - 1 : -1;
  const calmar = dd < 0 ? cagr / -dd : 0;
  return { finalMult: eq, maxDD: dd, sharpe, calmar };
}

// Stationary bootstrap (Politis & Romano 1994): walk forward from a random start,
// continuing the same block with prob (1 - 1/blockMean) and jumping to a new random
// index otherwise. Block lengths are geometric with mean `blockMean`, wrapping
// circularly, so serial dependence is preserved without a fixed block size.
function stationaryResample(rets: number[], blockMean: number, rng: () => number, out: number[]): void {
  const n = rets.length, jump = 1 / Math.max(1.0001, blockMean);
  let i = Math.floor(rng() * n) % n;
  for (let k = 0; k < n; k++) {
    out[k] = rets[i];
    if (rng() < jump) i = Math.floor(rng() * n) % n;
    else i = (i + 1) % n;
  }
}

export function monteCarlo(rets: number[], opts: { n?: number; blockMean?: number; ppy?: number; seed?: number; ddThresholds?: number[] } = {}): McResult {
  const clean = rets.filter((r) => Number.isFinite(r));
  const n = opts.n ?? 5000;
  const blockMean = opts.blockMean ?? 15;
  const ppy = opts.ppy ?? 365;
  const seed = opts.seed ?? 12345;
  const ddTh = opts.ddThresholds ?? [-0.30, -0.40, -0.50];
  const rng = mulberry32(seed);
  const fm: number[] = [], md: number[] = [], sh: number[] = [], ca: number[] = [];
  const buf = new Array<number>(clean.length);
  let nLoss = 0;
  const ddHits = ddTh.map(() => 0);
  if (clean.length < 2) {
    const empty: McPctl = { p5: NaN, p25: NaN, p50: NaN, p75: NaN, p95: NaN, p99: NaN };
    return { n: 0, blockMean, bars: clean.length, ppy, finalMult: empty, maxDD: empty, sharpe: empty, calmar: empty, pLoss: NaN, pDDworse: {}, histFinalMult: NaN, histMaxDD: NaN, histSharpe: NaN };
  }
  for (let s = 0; s < n; s++) {
    stationaryResample(clean, blockMean, rng, buf);
    const st = pathStats(buf, ppy);
    fm.push(st.finalMult); md.push(st.maxDD); sh.push(st.sharpe); ca.push(st.calmar);
    if (st.finalMult < 1) nLoss++;
    ddTh.forEach((t, j) => { if (st.maxDD < t) ddHits[j]++; });
  }
  const hist = pathStats(clean, ppy);
  const pDDworse: Record<string, number> = {};
  ddTh.forEach((t, j) => { pDDworse[`${(t * 100).toFixed(0)}%`] = ddHits[j] / n; });
  return {
    n, blockMean, bars: clean.length, ppy,
    finalMult: P(fm), maxDD: P(md), sharpe: P(sh), calmar: P(ca),
    pLoss: nLoss / n, pDDworse,
    histFinalMult: hist.finalMult, histMaxDD: hist.maxDD, histSharpe: hist.sharpe,
  };
}
