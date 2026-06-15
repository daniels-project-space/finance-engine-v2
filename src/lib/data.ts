// Candle store: R2-backed columnar bars with gap validation and incremental append.
//
// Provider strategy (probed 2026-06-12 from US cloud, where Trigger workers run):
//   - Binance live API: 451 geo-blocked. Bybit: 403 geo-blocked.
//   - data.binance.vision (archive CDN): open -> BULK BACKFILL (exact Binance
//     USDT-M perp klines + funding, complete months)
//   - OKX public API: open -> LIVE TAIL (perp candles + funding)
// Splicing Binance history with an OKX tail costs a few bps of cross-venue
// basis at the boundary — immaterial at 1h with 7bps/side modeled costs.

import { okxFunding, okxKlines } from "./okx";
import { visionFunding, visionKlines, visionSpotKlines, visionMetrics } from "./vision";
import { binanceOpenInterestHist, binanceLongShortRatio } from "./binanceFutures";
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

function startOfCurrentMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Fetch/refresh bars from history start (or extend existing), validate, store to R2. */
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
  const sources: string[] = [];
  const bars: Bars = existing ?? { symbol, tf, t: [], o: [], h: [], l: [], c: [], v: [], fundingT: [], fundingR: [] };
  const push = (r: { t: number; o: number; h: number; l: number; c: number; v: number }) => {
    if (r.t > lastClosedOpen) return;
    if (bars.t.length && r.t <= bars.t[bars.t.length - 1]) return;
    bars.t.push(r.t); bars.o.push(r.o); bars.h.push(r.h); bars.l.push(r.l); bars.c.push(r.c); bars.v.push(r.v);
    appended++;
  };

  if (from <= lastClosedOpen) {
    // bulk backfill from the archive for complete months
    const visionEnd = startOfCurrentMonth(now) - 1;
    if (visionEnd - from > 50 * tfMs) {
      const rows = await visionKlines(symbol, tf, from, visionEnd, log);
      for (const r of rows) push(r);
      if (rows.length) sources.push("vision");
    }
    // live tail from OKX
    const tailFrom = bars.t.length ? bars.t[bars.t.length - 1] + tfMs : from;
    if (tailFrom <= lastClosedOpen) {
      const rows = await okxKlines(symbol, tf, tailFrom, lastClosedOpen + tfMs - 1, log);
      for (const r of rows) push(r);
      if (rows.length) sources.push("okx");
    }
  }

  // funding: archive for complete months, OKX for the tail
  bars.fundingT = bars.fundingT ?? []; bars.fundingR = bars.fundingR ?? [];
  const fFrom = bars.fundingT.length ? bars.fundingT[bars.fundingT.length - 1] + 1 : historyStartTs;
  if (fFrom < now) {
    const visionEnd = startOfCurrentMonth(now) - 1;
    if (visionEnd - fFrom > 86_400_000 * 3) {
      const f = await visionFunding(symbol, fFrom, visionEnd, log);
      for (let i = 0; i < f.t.length; i++) {
        if (!bars.fundingT.length || f.t[i] > bars.fundingT[bars.fundingT.length - 1]) {
          bars.fundingT.push(f.t[i]); bars.fundingR.push(f.r[i]);
        }
      }
    }
    const fTail = bars.fundingT.length ? bars.fundingT[bars.fundingT.length - 1] + 1 : fFrom;
    const f2 = await okxFunding(symbol, fTail, now, log);
    for (let i = 0; i < f2.t.length; i++) {
      if (!bars.fundingT.length || f2.t[i] > bars.fundingT[bars.fundingT.length - 1]) {
        bars.fundingT.push(f2.t[i]); bars.fundingR.push(f2.r[i]);
      }
    }
  }

  // ---- WAVE-3a: perp-spot basis (bar-aligned SPOT close) ----
  // Backfill spot for ANY bar lacking a spotC value (covers first run + appended
  // tail). Spot is aligned strictly bar-for-bar against the perp t array. Source
  // is the SAME binance.vision archive as the perp klines.
  if (bars.t.length) {
    bars.spotC = bars.spotC ?? [];
    while (bars.spotC.length < bars.t.length) bars.spotC.push(0); // pad missing as 0 (basis=0 there)
    // index of the first bar whose spot is still unfilled (0 sentinel)
    let firstUnfilled = 0;
    while (firstUnfilled < bars.spotC.length && bars.spotC[firstUnfilled] > 0) firstUnfilled++;
    if (firstUnfilled < bars.t.length) {
      const spotFrom = bars.t[firstUnfilled], spotTo = bars.t[bars.t.length - 1];
      const spotMap = new Map<number, number>();
      const visionEnd = startOfCurrentMonth(now) - 1;
      if (visionEnd >= spotFrom) {
        const srows = await visionSpotKlines(symbol, tf, spotFrom, Math.min(spotTo, visionEnd), log);
        for (const r of srows) spotMap.set(r.t, r.c);
      }
      // spot tail from OKX SPOT (instId without -SWAP). okxKlines targets perp;
      // for the small tail the perp close is an acceptable spot proxy ONLY if no
      // spot is available — but we prefer leaving 0 (basis=0) over fabricating.
      for (let i = firstUnfilled; i < bars.t.length; i++) {
        const c = spotMap.get(bars.t[i]);
        if (c !== undefined && c > 0) bars.spotC[i] = c;
      }
    }
  }

  // ---- WAVE-3a: open interest + taker long/short ratio ----
  // Archive (daily metrics, ~5min stamps) for complete history, live fapi tail.
  bars.oiT = bars.oiT ?? []; bars.oiV = bars.oiV ?? [];
  bars.lsrT = bars.lsrT ?? []; bars.lsrR = bars.lsrR ?? [];
  {
    const metricsFrom = bars.oiT.length ? bars.oiT[bars.oiT.length - 1] + 1 : historyStartTs;
    const visionEnd = startOfCurrentMonth(now) - 1; // archive lags ~1 month
    if (visionEnd - metricsFrom > 86_400_000) {
      const ms = await visionMetrics(symbol, metricsFrom, visionEnd, log);
      for (let i = 0; i < ms.oiT.length; i++) {
        if (!bars.oiT.length || ms.oiT[i] > bars.oiT[bars.oiT.length - 1]) { bars.oiT.push(ms.oiT[i]); bars.oiV.push(ms.oiV[i]); }
      }
      for (let i = 0; i < ms.lsrT.length; i++) {
        if (!bars.lsrT.length || ms.lsrT[i] > bars.lsrT[bars.lsrT.length - 1]) { bars.lsrT.push(ms.lsrT[i]); bars.lsrR.push(ms.lsrR[i]); }
      }
    }
    // live tail (fapi data endpoints; ~30d). Skips cleanly (no fake) if blocked.
    const oiTail = bars.oiT.length ? bars.oiT[bars.oiT.length - 1] + 1 : historyStartTs;
    const oiT2 = await binanceOpenInterestHist(symbol, tf, oiTail, now, log);
    for (let i = 0; i < oiT2.t.length; i++) {
      if (!bars.oiT.length || oiT2.t[i] > bars.oiT[bars.oiT.length - 1]) { bars.oiT.push(oiT2.t[i]); bars.oiV.push(oiT2.v[i]); }
    }
    const lsrTail = bars.lsrT.length ? bars.lsrT[bars.lsrT.length - 1] + 1 : historyStartTs;
    const lsr2 = await binanceLongShortRatio(symbol, tf, lsrTail, now, log);
    for (let i = 0; i < lsr2.t.length; i++) {
      if (!bars.lsrT.length || lsr2.t[i] > bars.lsrT[bars.lsrT.length - 1]) { bars.lsrT.push(lsr2.t[i]); bars.lsrR.push(lsr2.r[i]); }
    }
  }

  // validation: count gaps + flag outliers
  let gaps = 0;
  for (let i = 1; i < bars.t.length; i++) {
    if (bars.t[i] - bars.t[i - 1] > tfMs * 1.5) gaps++;
    const r = bars.c[i] / bars.c[i - 1] - 1;
    if (Math.abs(r) > 0.35) log?.(`OUTLIER ${symbol} ${new Date(bars.t[i]).toISOString()}: ${(r * 100).toFixed(1)}% bar`);
  }

  // persist if klines changed OR the WAVE-3a series gained data (basis/oi/lsr) OR first run
  const cryptoNativeFilled = (bars.spotC?.some((x) => x > 0) ?? false) || (bars.oiT?.length ?? 0) > 0 || (bars.lsrT?.length ?? 0) > 0;
  if (appended > 0 || !existing || cryptoNativeFilled) await putJsonGz(candleKey(symbol, tf), bars);
  return {
    symbol, tf, bars: bars.t.length, appended, gaps,
    firstTs: bars.t[0] ?? 0, lastTs: bars.t[bars.t.length - 1] ?? 0,
    fundingLastTs: bars.fundingT.length ? bars.fundingT[bars.fundingT.length - 1] : undefined,
    source: sources.join("+") || "cache",
  };
}

/** Derive 4h bars from 1h (saves API paging; exact aggregation). */
export function aggregateBars(src: Bars, targetTf: "4h" | "1d"): Bars {
  const factor = targetTf === "4h" ? 4 : 24;
  const tfMs = TF_MS[src.tf];
  // funding + oi/lsr are ABSOLUTE-timestamp stamp series; the per-bar forward-fill
  // in compile.toArrays is tf-agnostic, so carry them through unchanged. Basis is
  // bar-aligned spot, so it must be re-bucketed to the target close (last spot in bucket).
  const out: Bars = {
    symbol: src.symbol, tf: targetTf, t: [], o: [], h: [], l: [], c: [], v: [],
    fundingT: src.fundingT, fundingR: src.fundingR,
    oiT: src.oiT, oiV: src.oiV, lsrT: src.lsrT, lsrR: src.lsrR,
    spotC: src.spotC ? [] : undefined,
  };
  const targetMs = tfMs * factor;
  let i = 0;
  while (i < src.t.length) {
    const bucketStart = Math.floor(src.t[i] / targetMs) * targetMs;
    let o = src.o[i], h = src.h[i], l = src.l[i], c = src.c[i], v = src.v[i];
    let sc = src.spotC ? src.spotC[i] : undefined;
    let j = i + 1;
    while (j < src.t.length && src.t[j] < bucketStart + targetMs) {
      h = Math.max(h, src.h[j]); l = Math.min(l, src.l[j]); c = src.c[j]; v += src.v[j];
      if (src.spotC) sc = src.spotC[j]; // spot close aligned to the perp close of the bucket
      j++;
    }
    if (j < src.t.length || src.t[i] + targetMs <= src.t[src.t.length - 1] + tfMs) {
      out.t.push(bucketStart); out.o.push(o); out.h.push(h); out.l.push(l); out.c.push(c); out.v.push(v);
      if (src.spotC) (out.spotC as number[]).push(sc ?? 0);
    }
    i = j;
  }
  return out;
}
