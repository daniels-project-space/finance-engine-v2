// Regime classification from price + volatility ONLY (no strategy state).
//
// Two axes, combined into up to 6 regimes:
//   - volatility tercile: trailing realized-vol (rolling std of log returns)
//     bucketed against its own low/high terciles -> low | med | high
//   - trend sign: sign of the N-bar return -> up | down (flat folds into the
//     nearest sign; a true 0 return is rare and treated as "up")
//
// Bars before enough history exists (warmup) are labelled -1 (unclassified) and
// excluded by callers. Labels are 0..5 = volBucket*2 + trendBit.

export type RegimeLabel = number; // 0..5, or -1 unclassified

export interface RegimeOpts {
  /** lookback for trailing realized vol (bars) */
  volWindow?: number;
  /** lookback for trend sign (bars) */
  trendWindow?: number;
  /** explicit vol tercile cuts; if omitted, computed from the series itself */
  volCuts?: { lo: number; hi: number };
}

export interface RegimeResult {
  /** per-bar label aligned to closes (length = closes.length); -1 = warmup */
  labels: Int8Array;
  /** the vol tercile cut points actually used */
  volCuts: { lo: number; hi: number };
  /** human-readable name per label index 0..5 */
  names: string[];
}

export const REGIME_NAMES = [
  "lowvol-down", "lowvol-up",
  "medvol-down", "medvol-up",
  "highvol-down", "highvol-up",
];

/** trailing realized vol (population std of log returns over volWindow), per bar. */
function trailingVol(closes: number[] | Float64Array, volWindow: number): Float64Array {
  const n = closes.length;
  const logr = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const a = closes[i], b = closes[i - 1];
    logr[i] = a > 0 && b > 0 ? Math.log(a / b) : 0;
  }
  const vol = new Float64Array(n).fill(NaN);
  // rolling mean/var of logr over [i-volWindow+1, i]
  let s = 0, sq = 0;
  for (let i = 1; i < n; i++) {
    s += logr[i]; sq += logr[i] * logr[i];
    if (i > volWindow) { s -= logr[i - volWindow]; sq -= logr[i - volWindow] * logr[i - volWindow]; }
    const cnt = Math.min(i, volWindow);
    if (cnt >= Math.max(5, Math.floor(volWindow / 2))) {
      const mean = s / cnt;
      vol[i] = Math.sqrt(Math.max(0, sq / cnt - mean * mean));
    }
  }
  return vol;
}

/** percentile cut of finite values (p in [0,1]). */
function quantile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))));
  return s[idx];
}

/**
 * Classify every bar into a price/vol regime. Pure function of closes; no
 * forward leakage in the LABELS used for bucketing returns because vol/trend
 * are trailing. (The tercile CUTS are full-sample by default — acceptable for
 * descriptive bucketing of OOS pnl; pass explicit volCuts for strict causality.)
 */
export function classifyRegimes(closes: number[] | Float64Array, opts: RegimeOpts = {}): RegimeResult {
  const n = closes.length;
  const volWindow = opts.volWindow ?? 48;
  const trendWindow = opts.trendWindow ?? 96;
  const vol = trailingVol(closes, volWindow);

  let cuts = opts.volCuts;
  if (!cuts) {
    const finite: number[] = [];
    for (let i = 0; i < n; i++) if (Number.isFinite(vol[i])) finite.push(vol[i]);
    cuts = { lo: quantile(finite, 1 / 3), hi: quantile(finite, 2 / 3) };
  }

  const labels = new Int8Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(vol[i]) || i < trendWindow) continue;
    const past = closes[i - trendWindow];
    const cur = closes[i];
    if (!(past > 0) || !(cur > 0)) continue;
    const trendBit = cur >= past ? 1 : 0; // up=1, down=0
    const volBucket = vol[i] <= cuts.lo ? 0 : vol[i] <= cuts.hi ? 1 : 2;
    labels[i] = volBucket * 2 + trendBit;
  }
  return { labels, volCuts: cuts, names: REGIME_NAMES };
}

export interface RegimeBucket {
  label: number;
  name: string;
  n: number;
  sharpe: number;
  meanRet: number;
  totalPnl: number; // sum of returns (additive pnl proxy)
}

export interface RegimeBreakdown {
  buckets: RegimeBucket[];
  /** map label name -> annualized sharpe, only for buckets with >= minObs */
  sharpeByName: Record<string, number>;
  /** true if >80% of (positive) additive pnl came from a single regime */
  pnlConcentration: boolean;
  /** the dominant regime name + its share of total positive pnl */
  dominant?: { name: string; share: number };
  /** min sharpe across well-populated buckets (Infinity if none qualify) */
  minWellPopulatedSharpe: number;
}

/**
 * Bucket a return stream by regime label and compute per-regime stats.
 * `labels` must align index-for-index with `ret`. `ppy` annualizes Sharpe.
 * Only buckets with >= minObs observations are reported in sharpeByName /
 * minWellPopulatedSharpe; concentration is computed over ALL buckets' pnl.
 */
export function regimeBreakdown(
  ret: number[] | Float64Array,
  labels: Int8Array | number[],
  ppy: number,
  minObs = 30,
): RegimeBreakdown {
  const acc = new Map<number, { s: number; sq: number; n: number }>();
  const n = Math.min(ret.length, labels.length);
  for (let i = 0; i < n; i++) {
    const lab = labels[i];
    if (lab < 0) continue;
    const r = ret[i];
    if (!Number.isFinite(r)) continue;
    const cur = acc.get(lab) ?? { s: 0, sq: 0, n: 0 };
    cur.s += r; cur.sq += r * r; cur.n++;
    acc.set(lab, cur);
  }
  const buckets: RegimeBucket[] = [];
  for (const [lab, a] of acc) {
    const mean = a.s / a.n;
    const sd = Math.sqrt(Math.max(0, a.sq / a.n - mean * mean));
    buckets.push({
      label: lab,
      name: REGIME_NAMES[lab] ?? `regime-${lab}`,
      n: a.n,
      sharpe: sd > 1e-12 ? (mean / sd) * Math.sqrt(ppy) : 0,
      meanRet: mean,
      totalPnl: a.s,
    });
  }
  buckets.sort((x, y) => x.label - y.label);

  const sharpeByName: Record<string, number> = {};
  let minWell = Infinity;
  for (const b of buckets) {
    if (b.n >= minObs) {
      sharpeByName[b.name] = b.sharpe;
      if (b.sharpe < minWell) minWell = b.sharpe;
    }
  }

  // concentration over POSITIVE additive pnl (a strategy that only earns in one
  // regime concentrates its gains there). Sum positive bucket pnl; flag if the
  // single largest positive contributor is >80% of the positive total.
  const positivePnls = buckets.map((b) => Math.max(0, b.totalPnl));
  const posTotal = positivePnls.reduce((s, v) => s + v, 0);
  let dominant: { name: string; share: number } | undefined;
  let pnlConcentration = false;
  if (posTotal > 0) {
    let bestI = 0;
    for (let i = 1; i < positivePnls.length; i++) if (positivePnls[i] > positivePnls[bestI]) bestI = i;
    const share = positivePnls[bestI] / posTotal;
    dominant = { name: buckets[bestI].name, share };
    pnlConcentration = share > 0.8;
  }

  return { buckets, sharpeByName, pnlConcentration, dominant, minWellPopulatedSharpe: minWell };
}
