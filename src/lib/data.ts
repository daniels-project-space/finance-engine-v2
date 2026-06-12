// Candle store: R2-backed columnar bars with gap validation and incremental append.
import { fetchFunding, fetchKlines } from "./binance";
import { candleKey, getJsonGz, putJsonGz } from "./storage";
import type { Bars } from "../engine/types";

const TF_MS: Record<string, number> = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

export async function loadBars(symbol: string, tf: string): Promise<Bars | null> {
  return getJsonGz<Bars>(candleKey(symbol, tf));
}

export interface IngestResult {
  symbol: string; tf: string; bars: number; appended: number; gaps: number;
  firstTs: number; lastTs: number; fundingLastTs?: number; source: string;
}

/** Fetch/refresh bars from `sinceTs` (or extend existing), validate, store to R2. */
export async function ingestSymbol(
  symbol: string, tf: string, historyStartTs: number, log?: (m: string) => void,
): Promise<IngestResult> {
  const tfMs = TF_MS[tf];
  if (!tfMs) throw new Error(`unsupported tf ${tf}`);
  const existing = await loadBars(symbol, tf);
  const now = Date.now();
  const lastClosedOpen = Math.floor(now / tfMs) * tfMs - tfMs; // open time of last CLOSED bar
  const from = existing && existing.t.length ? existing.t[existing.t.length - 1] + tfMs : historyStartTs;

  let appended = 0;
  let source = "cache";
  const bars: Bars = existing ?? { symbol, tf, t: [], o: [], h: [], l: [], c: [], v: [], fundingT: [], fundingR: [] };

  if (from <= lastClosedOpen) {
    const { rows, source: src } = await fetchKlines(symbol, tf, from, lastClosedOpen + tfMs, log);
    source = src;
    for (const r of rows) {
      if (r.t > lastClosedOpen) continue; // skip the still-open bar
      if (bars.t.length && r.t <= bars.t[bars.t.length - 1]) continue;
      bars.t.push(r.t); bars.o.push(r.o); bars.h.push(r.h); bars.l.push(r.l); bars.c.push(r.c); bars.v.push(r.v);
      appended++;
    }
  }

  // funding (perp only; harmless empty on spot fallback)
  bars.fundingT = bars.fundingT ?? []; bars.fundingR = bars.fundingR ?? [];
  const fFrom = bars.fundingT.length ? bars.fundingT[bars.fundingT.length - 1] + 1 : historyStartTs;
  if (fFrom < now) {
    const f = await fetchFunding(symbol, fFrom, now, log);
    for (let i = 0; i < f.t.length; i++) { bars.fundingT.push(f.t[i]); bars.fundingR.push(f.r[i]); }
  }

  // validation: count gaps + flag outliers
  let gaps = 0;
  for (let i = 1; i < bars.t.length; i++) {
    if (bars.t[i] - bars.t[i - 1] > tfMs * 1.5) gaps++;
    const r = bars.c[i] / bars.c[i - 1] - 1;
    if (Math.abs(r) > 0.35) log?.(`OUTLIER ${symbol} ${new Date(bars.t[i]).toISOString()}: ${(r * 100).toFixed(1)}% bar`);
  }

  if (appended > 0 || !existing) await putJsonGz(candleKey(symbol, tf), bars);
  return {
    symbol, tf, bars: bars.t.length, appended, gaps,
    firstTs: bars.t[0] ?? 0, lastTs: bars.t[bars.t.length - 1] ?? 0,
    fundingLastTs: bars.fundingT.length ? bars.fundingT[bars.fundingT.length - 1] : undefined,
    source,
  };
}

/** Derive 4h bars from 1h (saves API paging; exact aggregation). */
export function aggregateBars(src: Bars, targetTf: "4h" | "1d"): Bars {
  const factor = targetTf === "4h" ? 4 : 24;
  const tfMs = TF_MS[src.tf];
  const out: Bars = { symbol: src.symbol, tf: targetTf, t: [], o: [], h: [], l: [], c: [], v: [], fundingT: src.fundingT, fundingR: src.fundingR };
  const targetMs = tfMs * factor;
  let i = 0;
  while (i < src.t.length) {
    const bucketStart = Math.floor(src.t[i] / targetMs) * targetMs;
    let o = src.o[i], h = src.h[i], l = src.l[i], c = src.c[i], v = src.v[i];
    let j = i + 1;
    while (j < src.t.length && src.t[j] < bucketStart + targetMs) {
      h = Math.max(h, src.h[j]); l = Math.min(l, src.l[j]); c = src.c[j]; v += src.v[j];
      j++;
    }
    // only emit complete buckets
    if (j < src.t.length || src.t[i] + targetMs <= src.t[src.t.length - 1] + tfMs) {
      out.t.push(bucketStart); out.o.push(o); out.h.push(h); out.l.push(l); out.c.push(c); out.v.push(v);
    }
    i = j;
  }
  return out;
}
