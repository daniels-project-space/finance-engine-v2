// Correlation-aware strategy BOOK (ensemble). Wave-2 shadow rigor: turns the
// one-champion hunter into a diversified book and scores how much a NEW
// candidate would add to it.
//
// All functions are pure and SHADOW-ONLY — nothing here binds promotion or the
// composite. The gauntlet/process layer computes these as additive metrics.
//
//   - correlationMatrix : Pearson over timestamp-aligned OOS return streams.
//   - ercWeights        : Equal-Risk-Contribution (risk-parity) allocation.
//   - bookStats         : book OOS Sharpe / vol / maxDD at given weights.
//   - marginalContribution : book-Sharpe lift from adding a candidate (re-ERC'd)
//                            plus its max pairwise correlation to current members.
//   - bookQualifies     : shadow flag (marginal lift OR low-corr + positive edge).

export interface Stream {
  /** identifier (candidateId or name) — for diagnostics only */
  id: string;
  /** bar timestamps (ms), strictly increasing */
  t: number[] | Float64Array;
  /** per-bar OOS returns aligned index-for-index with t */
  ret: number[] | Float64Array;
}

// ----------------------------------------------------------------- alignment
/**
 * Align a set of streams on their COMMON timestamps (inner join). Returns a
 * dense matrix R[stream][k] over the shared, sorted timestamp axis, plus the
 * axis itself. A timestamp is kept only if EVERY stream carries it.
 */
export function alignStreams(streams: Stream[]): { t: number[]; R: number[][] } {
  if (streams.length === 0) return { t: [], R: [] };
  const maps = streams.map((s) => {
    const m = new Map<number, number>();
    for (let i = 0; i < s.t.length; i++) m.set(Number(s.t[i]), Number(s.ret[i]));
    return m;
  });
  const first = maps[0];
  const common: number[] = [];
  for (const ts of first.keys()) {
    let inAll = true;
    for (let j = 1; j < maps.length; j++) if (!maps[j].has(ts)) { inAll = false; break; }
    if (inAll) common.push(ts);
  }
  common.sort((a, b) => a - b);
  const R: number[][] = maps.map((m) => common.map((ts) => m.get(ts) as number));
  return { t: common, R };
}

// ----------------------------------------------------------- basic moments
function meanStd(x: number[]): { mean: number; sd: number } {
  const n = x.length;
  if (n === 0) return { mean: 0, sd: 0 };
  let s = 0;
  for (const v of x) s += v;
  const mean = s / n;
  let sq = 0;
  for (const v of x) { const d = v - mean; sq += d * d; }
  return { mean, sd: Math.sqrt(sq / n) };
}

/** Pearson correlation of two equal-length series; 0 if either is constant. */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = meanStd(a.slice(0, n)), mb = meanStd(b.slice(0, n));
  if (ma.sd < 1e-15 || mb.sd < 1e-15) return 0;
  let cov = 0;
  for (let i = 0; i < n; i++) cov += (a[i] - ma.mean) * (b[i] - mb.mean);
  cov /= n;
  return Math.max(-1, Math.min(1, cov / (ma.sd * mb.sd)));
}

/**
 * Correlation matrix over timestamp-aligned OOS return streams. Streams are
 * inner-joined on common timestamps first. Diagonal is 1; symmetric.
 */
export function correlationMatrix(streams: Stream[]): { matrix: number[][]; t: number[] } {
  const { t, R } = alignStreams(streams);
  const k = R.length;
  const matrix: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < k; j++) {
      const c = pearson(R[i], R[j]);
      matrix[i][j] = c;
      matrix[j][i] = c;
    }
  }
  return { matrix, t };
}

// --------------------------------------------------------- covariance helpers
/** Population covariance matrix of the dense aligned rows R[stream][k]. */
export function covarianceMatrix(R: number[][]): number[][] {
  const k = R.length;
  const n = k ? R[0].length : 0;
  const means = R.map((row) => { let s = 0; for (const v of row) s += v; return n ? s / n : 0; });
  const cov: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      let s = 0;
      for (let x = 0; x < n; x++) s += (R[i][x] - means[i]) * (R[j][x] - means[j]);
      const c = n ? s / n : 0;
      cov[i][j] = c; cov[j][i] = c;
    }
  }
  return cov;
}

// ------------------------------------------------------------------ ERC core
export interface ErcResult {
  weights: number[];
  /** per-asset risk contribution share (sums to 1) at the returned weights */
  riskContrib: number[];
  iterations: number;
  converged: boolean;
}

/**
 * Equal-Risk-Contribution (risk parity) weights from a covariance matrix.
 * Long-only, fully invested (weights >= 0, sum to 1). Multiplicative
 * fixed-point update toward equal risk contribution:
 *   w_i  <-  w_i * (target / RC_i)^damp ,  RC_i = w_i * (Sigma w)_i .
 * Converges for PSD Sigma; renormalizes each sweep. Convergence is declared
 * when the spread of normalized risk contributions falls below tol.
 */
export function ercFromCov(
  cov: number[][],
  cfg: { maxIter?: number; tol?: number; damp?: number } = {},
): ErcResult {
  const k = cov.length;
  const maxIter = cfg.maxIter ?? 5000;
  const tol = cfg.tol ?? 1e-9;
  const damp = cfg.damp ?? 0.5;
  if (k === 0) return { weights: [], riskContrib: [], iterations: 0, converged: true };
  if (k === 1) return { weights: [1], riskContrib: [1], iterations: 0, converged: true };

  const diag = cov.map((r, i) => r[i]);
  const maxVar = Math.max(...diag, 1e-18);
  const eps = 1e-12 * maxVar;
  // inverse-vol warm start (a good ERC seed)
  let w = diag.map((d) => 1 / Math.sqrt(Math.max(d, eps)));
  let sw0 = w.reduce((a, b) => a + b, 0);
  w = w.map((x) => x / sw0);

  const sigmaW = (wv: number[]) => wv.map((_, i) => {
    let s = 0;
    for (let j = 0; j < k; j++) s += cov[i][j] * wv[j];
    return s;
  });

  let iterations = 0;
  let converged = false;
  for (let it = 0; it < maxIter; it++) {
    iterations = it + 1;
    const sw_ = sigmaW(w);                          // (Sigma w)_i
    const rc = w.map((wi, i) => wi * sw_[i]);        // raw risk contributions
    const totalRisk = rc.reduce((a, b) => a + b, 0); // = w' Sigma w = sigma_p^2
    if (totalRisk <= 0) break;
    const target = totalRisk / k;                    // equal target per asset
    const wNew = w.map((wi, i) => {
      const ratio = target / Math.max(rc[i], 1e-30);
      return Math.max(0, wi * Math.pow(ratio, damp));
    });
    let s = wNew.reduce((a, b) => a + b, 0);
    if (s <= 0) break;
    for (let i = 0; i < k; i++) wNew[i] /= s;
    const rcShare = rc.map((x) => x / totalRisk);
    const spread = Math.max(...rcShare) - Math.min(...rcShare);
    w = wNew;
    if (spread < tol) { converged = true; break; }
  }
  const sw_ = sigmaW(w);
  const rc = w.map((wi, i) => wi * sw_[i]);
  const tot = rc.reduce((a, b) => a + b, 0) || 1;
  return { weights: w, riskContrib: rc.map((x) => x / tot), iterations, converged };
}

/** ERC weights directly from timestamp-aligned OOS return streams. */
export function ercWeights(streams: Stream[], cfg?: { maxIter?: number; tol?: number; damp?: number }): ErcResult {
  const { R } = alignStreams(streams);
  if (R.length === 0 || (R[0]?.length ?? 0) < 2) {
    const k = streams.length;
    const w = k ? new Array(k).fill(1 / k) : [];
    return { weights: w, riskContrib: w.slice(), iterations: 0, converged: false };
  }
  const cov = covarianceMatrix(R);
  return ercFromCov(cov, cfg);
}

// ------------------------------------------------------------------ bookStats
export interface BookStats {
  /** annualized Sharpe of the weighted book OOS returns */
  sharpe: number;
  /** annualized vol */
  vol: number;
  /** worst peak-to-trough on the book equity path */
  maxDD: number;
  /** mean per-bar return */
  meanRet: number;
  /** number of aligned bars used */
  nBars: number;
}

/**
 * Book OOS stats from streams + weights. Weights are matched positionally to the
 * streams; the book return per bar is sum_i w_i r_i over the common timestamp
 * axis. `ppy` annualizes (defaults to hourly 8760).
 */
export function bookStats(streams: Stream[], weights: number[], ppy = 8760): BookStats {
  const { R } = alignStreams(streams);
  const k = R.length;
  const n = k ? R[0].length : 0;
  if (k === 0 || n === 0) return { sharpe: 0, vol: 0, maxDD: 0, meanRet: 0, nBars: 0 };
  const w = normalizeWeights(weights.length === k ? weights : new Array(k).fill(1 / k));
  const book = combine(R, w);
  return statsOf(book, ppy);
}

/** annualized Sharpe/vol/maxDD/mean of a per-bar return series. */
export function statsOf(ret: number[], ppy: number): BookStats {
  const n = ret.length;
  if (n === 0) return { sharpe: 0, vol: 0, maxDD: 0, meanRet: 0, nBars: 0 };
  const { mean, sd } = meanStd(ret);
  const sharpe = sd > 1e-15 ? (mean / sd) * Math.sqrt(ppy) : 0;
  const vol = sd * Math.sqrt(ppy);
  let eq = 1, peak = 1, maxDD = 0;
  for (let i = 0; i < n; i++) {
    eq *= 1 + ret[i];
    if (eq > peak) peak = eq;
    const dd = eq / peak - 1;
    if (dd < maxDD) maxDD = dd;
  }
  return { sharpe, vol, maxDD, meanRet: mean, nBars: n };
}

function normalizeWeights(w: number[]): number[] {
  const s = w.reduce((a, b) => a + Math.max(0, b), 0);
  if (s <= 0) return w.map(() => 1 / Math.max(1, w.length));
  return w.map((x) => Math.max(0, x) / s);
}

function combine(rows: number[][], weights: number[]): number[] {
  const k = rows.length, n = k ? rows[0].length : 0;
  const w = normalizeWeights(weights.length === k ? weights : new Array(k).fill(1 / k));
  const out = new Array<number>(n).fill(0);
  for (let x = 0; x < n; x++) {
    let s = 0;
    for (let i = 0; i < k; i++) s += w[i] * rows[i][x];
    out[x] = s;
  }
  return out;
}

// ------------------------------------------------------ marginal contribution
export interface MarginalResult {
  /** book Sharpe with the candidate added (re-ERC'd over members+candidate) */
  newBookSharpe: number;
  /** book Sharpe of the current members only (re-ERC'd, same aligned window) */
  baseBookSharpe: number;
  /** newBookSharpe - baseBookSharpe (the diversification lift) */
  marginalSharpe: number;
  /** max |pairwise correlation| of the candidate to any current member */
  maxCorr: number;
  /** candidate standalone annualized OOS Sharpe */
  standaloneSharpe: number;
  /** the re-ERC'd weights of {members..., candidate} */
  newWeights: number[];
}

/**
 * Book-Sharpe gain from adding `candidate` to the current book {members}. Both
 * the base book and the augmented book are ERC-weighted and evaluated on the
 * SAME common-timestamp window so the lift is apples-to-apples. Also returns the
 * candidate's max pairwise correlation to the existing members and its
 * standalone Sharpe.
 *
 * When members is empty the base book Sharpe is 0 and marginalSharpe equals the
 * candidate's standalone Sharpe (adding the first strategy to an empty book).
 */
export function marginalContribution(
  candidate: Stream,
  members: Stream[],
  ppy = 8760,
  ercCfg?: { maxIter?: number; tol?: number; damp?: number },
): MarginalResult {
  const standalone = statsOf(Array.from(candidate.ret, Number), ppy).sharpe;

  if (members.length === 0) {
    return {
      newBookSharpe: standalone, baseBookSharpe: 0, marginalSharpe: standalone,
      maxCorr: 0, standaloneSharpe: standalone, newWeights: [1],
    };
  }

  // align members + candidate on their COMMON window so both books are measured
  // on the identical bar set.
  const all = [...members, candidate];
  const { R } = alignStreams(all);
  const k = R.length;
  const nBars = k ? R[0].length : 0;
  if (nBars < 2) {
    return {
      newBookSharpe: 0, baseBookSharpe: 0, marginalSharpe: 0,
      maxCorr: 0, standaloneSharpe: standalone, newWeights: new Array(k).fill(1 / Math.max(1, k)),
    };
  }
  const memberRows = R.slice(0, members.length);
  const allRows = R;

  const baseErc = ercFromCov(covarianceMatrix(memberRows), ercCfg);
  const baseSharpe = statsOf(combine(memberRows, baseErc.weights), ppy).sharpe;

  const newErc = ercFromCov(covarianceMatrix(allRows), ercCfg);
  const newSharpe = statsOf(combine(allRows, newErc.weights), ppy).sharpe;

  const candRow = allRows[allRows.length - 1];
  let maxCorr = 0;
  for (let i = 0; i < members.length; i++) {
    const c = Math.abs(pearson(candRow, allRows[i]));
    if (c > maxCorr) maxCorr = c;
  }

  return {
    newBookSharpe: newSharpe,
    baseBookSharpe: baseSharpe,
    marginalSharpe: newSharpe - baseSharpe,
    maxCorr,
    standaloneSharpe: standalone,
    newWeights: newErc.weights,
  };
}

// ------------------------------------------------------------- bookQualifies
export interface BookQualifyCfg {
  /** minimum marginal book-Sharpe gain to admit on lift alone (default 0.1) */
  minMarginalSharpe?: number;
  /** max pairwise corr to admit on the diversification path (default 0.6) */
  maxCorr?: number;
}

/**
 * Shadow admission flag for the candidate into the book. True if EITHER:
 *   (1) it lifts book Sharpe by >= minMarginalSharpe (it materially helps), OR
 *   (2) it is genuinely diversifying: maxCorr < maxCorr-knob AND standalone
 *       Sharpe > 0 (an uncorrelated positive sleeve, even if the immediate
 *       Sharpe lift is modest).
 * NEVER binds promotion — logged/persisted as a shadow signal only.
 */
export function bookQualifies(m: MarginalResult, cfg: BookQualifyCfg = {}): boolean {
  const minMarg = cfg.minMarginalSharpe ?? 0.1;
  const maxCorr = cfg.maxCorr ?? 0.6;
  if (m.marginalSharpe >= minMarg) return true;
  if (m.maxCorr < maxCorr && m.standaloneSharpe > 0) return true;
  return false;
}

// ------------------------------------------------------------- whole-book build
export interface BookMember { id: string; weight: number; riskContrib: number; standaloneSharpe: number }
export interface BookBuild {
  members: BookMember[];
  weights: number[];
  stats: BookStats;
  correlation: number[][];
  /** mean off-diagonal |correlation| — a one-number diversification gauge */
  meanAbsCorr: number;
  nBars: number;
}

/**
 * Build the whole would-be book from a set of OOS streams: ERC-weight them all,
 * compute book stats, the correlation matrix and per-member diagnostics. Empty
 * input yields an empty book (the live case until something survives).
 */
export function buildBook(streams: Stream[], ppy = 8760, ercCfg?: { maxIter?: number; tol?: number; damp?: number }): BookBuild {
  if (streams.length === 0) {
    return { members: [], weights: [], stats: { sharpe: 0, vol: 0, maxDD: 0, meanRet: 0, nBars: 0 }, correlation: [], meanAbsCorr: 0, nBars: 0 };
  }
  const erc = ercWeights(streams, ercCfg);
  const stats = bookStats(streams, erc.weights, ppy);
  const { matrix } = correlationMatrix(streams);
  let s = 0, cnt = 0;
  for (let i = 0; i < matrix.length; i++) for (let j = i + 1; j < matrix.length; j++) { s += Math.abs(matrix[i][j]); cnt++; }
  const meanAbsCorr = cnt ? s / cnt : 0;
  const members: BookMember[] = streams.map((st, i) => ({
    id: st.id,
    weight: erc.weights[i] ?? 0,
    riskContrib: erc.riskContrib[i] ?? 0,
    standaloneSharpe: statsOf(Array.from(st.ret, Number), ppy).sharpe,
  }));
  return { members, weights: erc.weights, stats, correlation: matrix, meanAbsCorr, nBars: stats.nBars };
}
