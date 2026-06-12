// Vectorized, strictly causal indicator kernels.
// Every value at index i uses data from indices <= i only. NaN during warmup.
//
// NaN-AWARE: composed indicators (zscore(ema(funding)), sma(roc(close)), ...)
// receive inputs whose warmup prefix is NaN. Every kernel starts its window at
// the input's first finite value instead of poisoning its accumulator — output
// is NaN until (firstFinite + period - 1), then valid. Without this, any
// indicator-of-indicator chain returns NaN forever and silently never trades.

function firstFinite(src: Float64Array): number {
  for (let i = 0; i < src.length; i++) if (!Number.isNaN(src[i])) return i;
  return src.length;
}

export function sma(src: Float64Array, n: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  const fv = firstFinite(src);
  let sum = 0;
  for (let i = fv; i < src.length; i++) {
    sum += src[i];
    if (i - fv >= n) sum -= src[i - n];
    if (i - fv >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(src: Float64Array, n: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  const fv = firstFinite(src);
  const k = 2 / (n + 1);
  let prev = NaN;
  let seedSum = 0;
  for (let i = fv; i < src.length; i++) {
    if (i - fv < n - 1) { seedSum += src[i]; continue; }
    if (i - fv === n - 1) { seedSum += src[i]; prev = seedSum / n; out[i] = prev; continue; }
    prev = src[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function wma(src: Float64Array, n: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  const fv = firstFinite(src);
  const denom = (n * (n + 1)) / 2;
  for (let i = fv + n - 1; i < src.length; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += src[i - j] * (n - j);
    out[i] = s / denom;
  }
  return out;
}

export function stdev(src: Float64Array, n: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  const fv = firstFinite(src);
  let sum = 0, sumSq = 0;
  for (let i = fv; i < src.length; i++) {
    sum += src[i]; sumSq += src[i] * src[i];
    if (i - fv >= n) { sum -= src[i - n]; sumSq -= src[i - n] * src[i - n]; }
    if (i - fv >= n - 1) {
      const mean = sum / n;
      const v = Math.max(0, sumSq / n - mean * mean);
      out[i] = Math.sqrt(v);
    }
  }
  return out;
}

export function rsi(src: Float64Array, n: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  const fv = firstFinite(src);
  let avgGain = 0, avgLoss = 0;
  for (let i = fv + 1; i < src.length; i++) {
    const ch = src[i] - src[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    const j = i - fv;
    if (j <= n) {
      avgGain += gain / n; avgLoss += loss / n;
      if (j === n) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

export function atr(h: Float64Array, l: Float64Array, c: Float64Array, n: number): Float64Array {
  const out = new Float64Array(c.length).fill(NaN);
  let prev = NaN;
  let seed = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i <= n) {
      seed += tr;
      if (i === n) { prev = seed / n; out[i] = prev; }
    } else {
      prev = (prev * (n - 1) + tr) / n;
      out[i] = prev;
    }
  }
  return out;
}

export function highest(src: Float64Array, n: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  const fv = firstFinite(src);
  const idx: number[] = [];
  for (let i = fv; i < src.length; i++) {
    while (idx.length && src[idx[idx.length - 1]] <= src[i]) idx.pop();
    idx.push(i);
    if (idx[0] <= i - n) idx.shift();
    if (i - fv >= n - 1) out[i] = src[idx[0]];
  }
  return out;
}

export function lowest(src: Float64Array, n: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  const fv = firstFinite(src);
  const idx: number[] = [];
  for (let i = fv; i < src.length; i++) {
    while (idx.length && src[idx[idx.length - 1]] >= src[i]) idx.pop();
    idx.push(i);
    if (idx[0] <= i - n) idx.shift();
    if (i - fv >= n - 1) out[i] = src[idx[0]];
  }
  return out;
}

export function lag(src: Float64Array, n: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  for (let i = n; i < src.length; i++) out[i] = src[i - n];
  return out;
}

export function roc(src: Float64Array, n: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  for (let i = n; i < src.length; i++) out[i] = src[i - n] === 0 ? NaN : src[i] / src[i - n] - 1;
  return out;
}

export function zscore(src: Float64Array, n: number): Float64Array {
  const m = sma(src, n);
  const s = stdev(src, n);
  const out = new Float64Array(src.length).fill(NaN);
  for (let i = 0; i < src.length; i++) {
    if (!Number.isNaN(m[i]) && s[i] > 1e-12) out[i] = (src[i] - m[i]) / s[i];
  }
  return out;
}

/** rolling linear-regression slope over n bars, normalized by current level (scale-free, per-bar drift) */
export function slope(src: Float64Array, n: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  const fv = firstFinite(src);
  const sx = (n * (n - 1)) / 2;
  const sxx = ((n - 1) * n * (2 * n - 1)) / 6;
  const denom = n * sxx - sx * sx;
  for (let i = fv + n - 1; i < src.length; i++) {
    let sy = 0, sxy = 0;
    for (let j = 0; j < n; j++) { const y = src[i - n + 1 + j]; sy += y; sxy += j * y; }
    const b = (n * sxy - sx * sy) / denom;
    out[i] = src[i] !== 0 ? b / Math.abs(src[i]) : NaN;
  }
  return out;
}

/** percentile rank of current value within trailing window, in [0,1] */
export function pctrank(src: Float64Array, n: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  const fv = firstFinite(src);
  for (let i = fv + n - 1; i < src.length; i++) {
    let below = 0;
    const x = src[i];
    for (let j = i - n + 1; j <= i; j++) if (src[j] <= x) below++;
    out[i] = below / n;
  }
  return out;
}

export function median(src: Float64Array, n: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  const fv = firstFinite(src);
  const buf = new Float64Array(n);
  for (let i = fv + n - 1; i < src.length; i++) {
    for (let j = 0; j < n; j++) buf[j] = src[i - n + 1 + j];
    const sorted = Array.from(buf).sort((a, b) => a - b);
    out[i] = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }
  return out;
}
