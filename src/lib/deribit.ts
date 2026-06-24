// Deribit DVOL (implied-vol index) — free public data, no auth. The 30-day
// constant-maturity implied-vol index for BTC & ETH (the liquid options markets),
// ~5.3y daily history. Source of the orthogonal options-IV signal that finally
// diversifies the book. We store the daily DVOL series in R2 and expose a loader
// plus the IV-RV spread (DVOL minus realized vol computed from the perp bars).

import { getJsonGz, putJsonGz } from "./storage";

const BASE = "https://www.deribit.com/api/v2/public";
/** DVOL exists ONLY for the liquid options markets. Do NOT extend to other coins. */
export const DVOL_CURRENCIES = ["BTC", "ETH"] as const;
export type DvolCurrency = (typeof DVOL_CURRENCIES)[number];

export interface DvolSeries { currency: string; t: number[]; close: number[] }

export function dvolKey(currency: string): string { return `dvol/${currency}.json.gz`; }

/** Map a perp symbol (BTC/USDT) to its DVOL currency, or null if none. */
export function dvolCurrencyFor(symbol: string): DvolCurrency | null {
  const base = symbol.split("/")[0];
  return (DVOL_CURRENCIES as readonly string[]).includes(base) ? (base as DvolCurrency) : null;
}

async function fetchDvolChunk(currency: string, start: number, end: number): Promise<[number, number][]> {
  const url = `${BASE}/get_volatility_index_data?currency=${currency}&start_timestamp=${start}&end_timestamp=${end}&resolution=86400`;
  const resp = await fetch(url, { headers: { "User-Agent": "finance-engine-v2" } });
  if (!resp.ok) throw new Error(`deribit ${resp.status}`);
  const j = await resp.json() as { result?: { data?: number[][] } };
  const rows = j.result?.data ?? [];
  // each row = [ts, open, high, low, close]; keep [dayStart, close]
  return rows.map((r) => [Math.floor(r[0] / 86400000) * 86400000, r[4]] as [number, number]);
}

/**
 * Backfill/refresh the daily DVOL series for `currency`, merging with any stored
 * data, and persist to R2. Returns the merged series. Idempotent + incremental:
 * fetches only from the last stored day forward (plus a small re-fetch overlap).
 */
export async function ingestDvol(currency: DvolCurrency, historyStartTs: number, log?: (m: string) => void): Promise<DvolSeries> {
  const existing = await getJsonGz<DvolSeries>(dvolKey(currency));
  const byDay = new Map<number, number>();
  if (existing) for (let i = 0; i < existing.t.length; i++) byDay.set(existing.t[i], existing.close[i]);
  const lastDay = existing && existing.t.length ? existing.t[existing.t.length - 1] : 0;
  // re-fetch the last few stored days (DVOL can revise) + everything after
  const from = Math.max(historyStartTs, lastDay ? lastDay - 5 * 86400000 : historyStartTs);
  const now = Date.now();
  let start = from, added = 0;
  while (start < now) {
    const end = Math.min(now, start + 86400000 * 300);
    let rows: [number, number][] = [];
    try { rows = await fetchDvolChunk(currency, start, end); }
    catch (e) { log?.(`dvol ${currency} chunk failed: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
    for (const [day, close] of rows) { if (!byDay.has(day)) added++; byDay.set(day, close); }
    start = end;
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const series: DvolSeries = { currency, t: days, close: days.map((d) => byDay.get(d)!) };
  await putJsonGz(dvolKey(currency), series);
  log?.(`dvol ${currency}: ${series.t.length} days (+${added}), ${new Date(series.t[0]).toISOString().slice(0, 10)} -> ${new Date(series.t[series.t.length - 1]).toISOString().slice(0, 10)}`);
  return series;
}

/** Load the stored DVOL series for a currency (or null). */
export async function loadDvol(currency: string): Promise<DvolSeries | null> {
  return getJsonGz<DvolSeries>(dvolKey(currency));
}

/** Build a day-start -> DVOL close map for fast point-in-time lookup. */
export function dvolMap(series: DvolSeries): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < series.t.length; i++) m.set(series.t[i], series.close[i]);
  return m;
}
