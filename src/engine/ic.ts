// WAVE-3a SIGNAL-IC research layer (SHADOW). Measures whether a signal actually
// predicts forward returns, so generation/dashboard can later PREFER high-IC
// signals over random price math. Nothing here changes any pass/fail or composite.
//
// Information Coefficient (IC) = the cross-sectional/time-series rank correlation
// between a signal at time t and the forward return over [t, t+h]. We use the
// time-series (per-symbol) IC on a single bar series: Spearman rank corr of
// signal_t vs fwdRet_{t->t+h}, computed over rolling NON-OVERLAPPING-ish samples.
//
// Causality: signal_t is known at the CLOSE of bar t (the DSL is strictly causal);
// the label is the return realized strictly AFTER t, so there is no look-ahead.
// We additionally drop the last h bars (no realizable forward return).

// ------------------------------------------------------------------ rank corr
/** Fractional ranks (ties get the average rank), 1-based averaged. */
export function ranks(x: number[]): number[] {
  const n = x.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => x[a] - x[b]);
  const r = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && x[idx[j + 1]] === x[idx[i]]) j++;
    const avg = (i + j) / 2 + 1; // average rank (1-based) over the tie block
    for (let k = i; k <= j; k++) r[idx[k]] = avg;
    i = j + 1;
  }
  return r;
}

/** Pearson correlation of two equal-length arrays. */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  const denom = Math.sqrt(va * vb);
  return denom > 1e-15 ? cov / denom : 0;
}

/** Spearman rank correlation. */
export function spearman(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  return pearson(ranks(a.slice(0, n)), ranks(b.slice(0, n)));
}

// ------------------------------------------------------------- forward returns
/**
 * h-bar forward simple returns aligned to the signal index: fwd[i] = c[i+h]/c[i]-1.
 * The last h entries are NaN (no realizable forward return).
 */
export function forwardReturns(closes: ArrayLike<number>, horizon: number): Float64Array {
  const n = closes.length;
  const h = Math.max(1, Math.floor(horizon));
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i + h < n; i++) {
    const a = closes[i], b = closes[i + h];
    out[i] = a > 0 ? b / a - 1 : NaN;
  }
  return out;
}

// --------------------------------------------------------------------- IC core
export interface ICResult {
  /** mean IC across the sampled windows */
  icMean: number;
  /** std of the per-window IC */
  icStd: number;
  /** Information Ratio of the IC = icMean / icStd (stability-adjusted predictive power) */
  icIR: number;
  /** t-stat of the per-window ICs against 0 = icMean / (icStd/sqrt(K)) */
  tStat: number;
  /** number of IC windows actually used */
  windows: number;
  /** total paired (signal, fwdReturn) finite observations */
  n: number;
  /** pooled single-shot Spearman IC over ALL finite pairs (window-free reference) */
  pooledIC: number;
}

const EMPTY_IC: ICResult = { icMean: 0, icStd: 0, icIR: 0, tStat: 0, windows: 0, n: 0, pooledIC: 0 };

/**
 * Information Coefficient of `signal` vs forward returns at `horizon` bars.
 *
 * `fwdReturns` is the pre-computed forward-return array aligned index-for-index
 * with `signal` (use forwardReturns(closes, horizon)). We:
 *   1) keep only indices where BOTH signal and fwdReturn are finite,
 *   2) split the kept stream into K contiguous windows (default ~ one per ~21
 *      forward-horizons of data, min 4, capped 60) and Spearman-correlate each,
 *   3) report mean/std/IR/t-stat over the per-window ICs + a pooled reference.
 *
 * Windowing gives an IC time series whose dispersion drives IC-IR and the t-stat
 * (the honest "is this predictive AND stable?" question), per Grinold/Kahn.
 */
export function informationCoefficient(
  signal: ArrayLike<number>,
  fwdReturns: ArrayLike<number>,
  horizon: number,
  cfg: { minPerWindow?: number; maxWindows?: number } = {},
): ICResult {
  const n = Math.min(signal.length, fwdReturns.length);
  const sigOk: number[] = [], retOk: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = signal[i], r = fwdReturns[i];
    if (Number.isFinite(s) && Number.isFinite(r)) { sigOk.push(s); retOk.push(r); }
  }
  const m = sigOk.length;
  if (m < 10) return { ...EMPTY_IC, n: m };

  const pooledIC = spearman(sigOk, retOk);

  // window sizing: each window holds enough points for a meaningful rank corr.
  const minPer = Math.max(cfg.minPerWindow ?? 20, Math.ceil(horizon * 1.5));
  const maxWin = cfg.maxWindows ?? 60;
  let K = Math.max(1, Math.min(maxWin, Math.floor(m / minPer)));
  if (K < 2) {
    // not enough data to form an IC time series: report the pooled IC as the mean
    // with zero dispersion (IR/t-stat undefined -> 0, honestly flagged by windows<2)
    return { icMean: pooledIC, icStd: 0, icIR: 0, tStat: 0, windows: 1, n: m, pooledIC };
  }
  const per = Math.floor(m / K);
  const ics: number[] = [];
  for (let w = 0; w < K; w++) {
    const s = w * per;
    const e = w === K - 1 ? m : s + per;
    const ic = spearman(sigOk.slice(s, e), retOk.slice(s, e));
    if (Number.isFinite(ic)) ics.push(ic);
  }
  if (!ics.length) return { ...EMPTY_IC, n: m, pooledIC };
  const mean = ics.reduce((a, b) => a + b, 0) / ics.length;
  let v = 0;
  for (const x of ics) v += (x - mean) * (x - mean);
  const std = Math.sqrt(v / ics.length);
  // Degenerate case: a perfectly-consistent IC (std≈0, mean≠0) is maximally
  // significant, not undefined. Saturate IR + t-stat instead of returning 0.
  const degenerate = std <= 1e-9 && Math.abs(mean) > 1e-9;
  const icIR = degenerate ? Math.sign(mean) * 99 : (std > 1e-9 ? mean / std : 0);
  const tStat = degenerate
    ? Math.sign(mean) * 99
    : (std > 1e-9 ? mean / (std / Math.sqrt(ics.length)) : 0);
  return { icMean: mean, icStd: std, icIR, tStat, windows: ics.length, n: m, pooledIC };
}

// ------------------------------------------------------------- orthogonality
export interface OrthogonalityResult {
  /** Spearman corr of the signal to each other signal, by name */
  corrByName: Record<string, number>;
  /** max |corr| to any other signal */
  maxAbsCorr: number;
  /** the name of the most-correlated other signal (or undefined) */
  mostCorrelated?: string;
}

/**
 * Correlation of one signal to a set of OTHER signals (Spearman over the finite
 * paired observations). High |corr| to an existing, higher-IC signal means this
 * one is redundant — that's the redundancy flag rankSignals() uses.
 */
export function signalOrthogonality(
  signal: ArrayLike<number>,
  others: { name: string; values: ArrayLike<number> }[],
): OrthogonalityResult {
  const corrByName: Record<string, number> = {};
  let maxAbs = 0, most: string | undefined;
  for (const o of others) {
    const n = Math.min(signal.length, o.values.length);
    const a: number[] = [], b: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = signal[i], y = o.values[i];
      if (Number.isFinite(x) && Number.isFinite(y)) { a.push(x); b.push(y); }
    }
    const c = a.length >= 10 ? spearman(a, b) : 0;
    corrByName[o.name] = c;
    if (Math.abs(c) > maxAbs) { maxAbs = Math.abs(c); most = o.name; }
  }
  return { corrByName, maxAbsCorr: maxAbs, mostCorrelated: most };
}

// ----------------------------------------------------------------- rankSignals
export interface NamedSignal { name: string; values: Float64Array }

export interface SignalRank {
  name: string;
  icMean: number;
  icIR: number;
  tStat: number;
  n: number;
  pooledIC: number;
  /** max |corr| to a HIGHER-IC signal */
  maxCorrToBetter: number;
  /** name of that higher-IC signal */
  redundantWith?: string;
  /** flagged redundant: |corr| to a higher-|IC-IR| signal exceeds redundancyCorr */
  redundant: boolean;
}

export interface RankSignalsResult {
  /** ranked by |icIR| descending */
  ranked: SignalRank[];
  horizon: number;
  redundancyCorr: number;
}

/**
 * Score EVERY provided signal's IC over forward returns, then flag redundancy:
 * a signal is redundant if it correlates (>= redundancyCorr) to another signal
 * that has a strictly higher |IC-IR|. Pure, deterministic, no side effects.
 *
 * `closes` defines the forward-return label; all signals must align index-for-
 * index with it. Use buildForwardReturns(closes, horizon) for the label.
 */
export function rankSignals(
  signals: NamedSignal[],
  closes: ArrayLike<number>,
  horizon: number,
  cfg: { redundancyCorr?: number; minPerWindow?: number; maxWindows?: number } = {},
): RankSignalsResult {
  const redundancyCorr = cfg.redundancyCorr ?? 0.8;
  const fwd = forwardReturns(closes, horizon);
  const ics = signals.map((s) => ({
    name: s.name,
    values: s.values,
    ic: informationCoefficient(s.values, fwd, horizon, { minPerWindow: cfg.minPerWindow, maxWindows: cfg.maxWindows }),
  }));
  // rank by |IC-IR| (predictive AND stable); pooledIC magnitude breaks ties
  const order = ics.slice().sort((a, b) =>
    Math.abs(b.ic.icIR) - Math.abs(a.ic.icIR) || Math.abs(b.ic.pooledIC) - Math.abs(a.ic.pooledIC));

  const ranked: SignalRank[] = order.map((cur, rankPos) => {
    // compare only to signals ranked ABOVE it (strictly higher |IC-IR|)
    const better = order.slice(0, rankPos).map((o) => ({ name: o.name, values: o.values }));
    const orth = signalOrthogonality(cur.values, better);
    const redundant = orth.maxAbsCorr >= redundancyCorr;
    return {
      name: cur.name,
      icMean: cur.ic.icMean,
      icIR: cur.ic.icIR,
      tStat: cur.ic.tStat,
      n: cur.ic.n,
      pooledIC: cur.ic.pooledIC,
      maxCorrToBetter: orth.maxAbsCorr,
      redundantWith: orth.mostCorrelated,
      redundant,
    };
  });
  return { ranked, horizon, redundancyCorr };
}

// --------------------------------------------------- pooled multi-symbol ranking
export interface SymbolSignals {
  /** per-symbol signal matrix; signal names must match across symbols */
  signals: NamedSignal[];
  closes: ArrayLike<number>;
}

/**
 * Rank signals pooling their (signal_t, fwdRet) pairs ACROSS multiple symbols, so
 * each signal's IC reflects cross-sectional predictive power, not one symbol's
 * luck. Per symbol we build the forward-return label and concatenate the finite
 * pairs per signal name; IC windows then run over the pooled stream.
 *
 * Redundancy: a signal is flagged if it correlates (>= redundancyCorr) to a
 * higher-|IC-IR| signal on the pooled, finite, paired observations.
 */
export function rankSignalsPooled(
  perSymbol: SymbolSignals[],
  horizon: number,
  cfg: { redundancyCorr?: number; minPerWindow?: number; maxWindows?: number } = {},
): RankSignalsResult {
  const redundancyCorr = cfg.redundancyCorr ?? 0.8;
  // Pool onto a COMMON index axis: concatenate every symbol's bars; per signal
  // hold its value at each pooled index (NaN where unavailable) AND the pooled
  // forward-return label. IC filters per-signal finite pairs; orthogonality
  // re-pairs two signals on the indices where BOTH are finite (true alignment).
  const names = Array.from(new Set(perSymbol.flatMap((s) => s.signals.map((x) => x.name))));
  const pooledSig = new Map<string, number[]>(names.map((n) => [n, []]));
  const pooledRet: number[] = [];
  for (const sym of perSymbol) {
    const fwd = forwardReturns(sym.closes, horizon);
    const byName = new Map(sym.signals.map((s) => [s.name, s.values]));
    const len = fwd.length;
    for (let i = 0; i < len; i++) {
      pooledRet.push(fwd[i]);
      for (const name of names) {
        const v = byName.get(name);
        pooledSig.get(name)!.push(v && i < v.length ? v[i] : NaN);
      }
    }
  }
  const icByName = new Map<string, ICResult>();
  for (const name of names) {
    icByName.set(name, informationCoefficient(pooledSig.get(name)!, pooledRet, horizon, { minPerWindow: cfg.minPerWindow, maxWindows: cfg.maxWindows }));
  }
  const order = names.slice().sort((a, b) => {
    const ia = icByName.get(a)!, ib = icByName.get(b)!;
    return Math.abs(ib.icIR) - Math.abs(ia.icIR) || Math.abs(ib.pooledIC) - Math.abs(ia.pooledIC);
  });

  const ranked: SignalRank[] = order.map((name, rankPos) => {
    const ic = icByName.get(name)!;
    const me = pooledSig.get(name)!;
    // orthogonality vs higher-ranked signals on the COMMON pooled axis (re-paired
    // on mutually-finite indices inside signalOrthogonality).
    const better = order.slice(0, rankPos).map((bn) => ({ name: bn, values: pooledSig.get(bn)! }));
    const orth = signalOrthogonality(me, better);
    return {
      name, icMean: ic.icMean, icIR: ic.icIR, tStat: ic.tStat, n: ic.n, pooledIC: ic.pooledIC,
      maxCorrToBetter: orth.maxAbsCorr, redundantWith: orth.mostCorrelated,
      redundant: orth.maxAbsCorr >= redundancyCorr,
    };
  });
  return { ranked, horizon, redundancyCorr };
}
