// Coin Metrics Community API — FREE, keyless on-chain metrics (community-api
// subdomain). Daily, BTC & ETH (the assets with full free coverage). License:
// CC BY-NC — fine for this paper/discovery engine; flagged for the later
// commercial decision (NOT real-money-live).
//
// POINT-IN-TIME: on-chain data publishes with ~1-day lag and revises. We store
// the raw daily series and LAG it by `ONCHAIN_LAG_DAYS` when attaching to bars,
// so a backtest at day t only ever sees values published by t-1. The look-ahead
// probe in smoke corrupts future on-chain values and asserts 0 change to the past.

import { getJsonGz, putJsonGz } from "./storage";

const BASE = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics";

/** Publication lag (days) — community data for day D is known on D+1. */
export const ONCHAIN_LAG_DAYS = 1;

/** Assets with full free community coverage. Do NOT extend without verifying. */
export const ONCHAIN_ASSETS = ["btc", "eth"] as const;
export type OnchainAsset = (typeof ONCHAIN_ASSETS)[number];

/** Free community metrics we ingest (verified available keyless). */
export const CM_METRICS = ["AdrActCnt", "CapMVRVCur", "TxCnt", "SplyCur", "CapMrktCurUSD", "FlowInExNtv", "FlowOutExNtv"] as const;

export interface OnchainSeries {
  asset: string;
  t: number[];                       // day-start ms (UTC)
  m: Record<string, (number | null)[]>; // metric -> per-day value (null = missing)
}

export function onchainKey(asset: string): string { return `onchain/cm_${asset}.json.gz`; }

/** Map a perp symbol (BTC/USDT) to its on-chain asset id, or null. */
export function onchainAssetFor(symbol: string): OnchainAsset | null {
  const base = symbol.split("/")[0].toLowerCase();
  return (ONCHAIN_ASSETS as readonly string[]).includes(base) ? (base as OnchainAsset) : null;
}

interface CmRow { time: string; [k: string]: string | undefined }

async function fetchPage(asset: string, metrics: string[], start: string, end: string): Promise<CmRow[]> {
  const out: CmRow[] = [];
  let url: string | null = `${BASE}?assets=${asset}&metrics=${metrics.join(",")}&frequency=1d&start_time=${start}&end_time=${end}&page_size=10000`;
  let guard = 0;
  while (url && guard++ < 50) {
    const resp = await fetch(url, { headers: { "User-Agent": "finance-engine-v2" } });
    if (!resp.ok) throw new Error(`coinmetrics ${resp.status}`);
    const j = await resp.json() as { data?: CmRow[]; next_page_url?: string };
    if (j.data) out.push(...j.data);
    url = j.next_page_url ?? null;
  }
  return out;
}

/** Backfill/refresh the daily on-chain series for an asset; merge + persist to R2. */
export async function ingestOnchain(asset: OnchainAsset, historyStartTs: number, log?: (m: string) => void): Promise<OnchainSeries> {
  const existing = await getJsonGz<OnchainSeries>(onchainKey(asset));
  const byDay = new Map<number, Record<string, number | null>>();
  if (existing) for (let i = 0; i < existing.t.length; i++) { const row: Record<string, number | null> = {}; for (const k of Object.keys(existing.m)) row[k] = existing.m[k][i]; byDay.set(existing.t[i], row); }
  const lastDay = existing && existing.t.length ? existing.t[existing.t.length - 1] : 0;
  // re-fetch the last few stored days (revisions) + everything after
  const from = Math.max(historyStartTs, lastDay ? lastDay - 5 * 86400000 : historyStartTs);
  const startISO = new Date(from).toISOString().slice(0, 10);
  const endISO = new Date(Date.now()).toISOString().slice(0, 10);
  let added = 0;
  try {
    const rows = await fetchPage(asset, [...CM_METRICS], startISO, endISO);
    for (const r of rows) {
      const day = Math.floor(Date.parse(r.time) / 86400000) * 86400000;
      const row = byDay.get(day) ?? {};
      let isNew = !byDay.has(day);
      for (const k of CM_METRICS) { const v = r[k]; row[k] = v !== undefined ? Number(v) : (row[k] ?? null); }
      byDay.set(day, row);
      if (isNew) added++;
    }
  } catch (e) { log?.(`coinmetrics ${asset} fetch failed: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const m: Record<string, (number | null)[]> = {};
  for (const k of CM_METRICS) m[k] = days.map((d) => byDay.get(d)?.[k] ?? null);
  const series: OnchainSeries = { asset, t: days, m };
  await putJsonGz(onchainKey(asset), series);
  log?.(`onchain ${asset}: ${days.length} days (+${added}), ${days.length ? new Date(days[0]).toISOString().slice(0, 10) : "-"} -> ${days.length ? new Date(days[days.length - 1]).toISOString().slice(0, 10) : "-"}`);
  return series;
}

export async function loadOnchain(asset: string): Promise<OnchainSeries | null> {
  return getJsonGz<OnchainSeries>(onchainKey(asset));
}

/** Derived metrics: exchange netflow (in-out, native) and a crude NVT (mktcap/txcnt).
 *  Returns a day-start -> {metric -> value} map, LAGGED by ONCHAIN_LAG_DAYS so a
 *  backtest at day t reads the value published by t-ONCHAIN_LAG_DAYS (point-in-time). */
export function onchainFeatureMap(series: OnchainSeries): Map<number, Record<string, number>> {
  const out = new Map<number, Record<string, number>>();
  const lagMs = ONCHAIN_LAG_DAYS * 86400000;
  for (let i = 0; i < series.t.length; i++) {
    const flowIn = series.m.FlowInExNtv?.[i], flowOut = series.m.FlowOutExNtv?.[i];
    const mktcap = series.m.CapMrktCurUSD?.[i], txcnt = series.m.TxCnt?.[i];
    const feat: Record<string, number> = {};
    if (series.m.CapMVRVCur?.[i] != null) feat.mvrv = series.m.CapMVRVCur[i] as number;
    if (series.m.AdrActCnt?.[i] != null) feat.activeaddr = series.m.AdrActCnt[i] as number;
    if (series.m.TxCnt?.[i] != null) feat.txcnt = series.m.TxCnt[i] as number;
    if (flowIn != null && flowOut != null) feat.exnetflow = (flowIn as number) - (flowOut as number); // +inflow (bearish), -outflow (bullish)
    if (mktcap != null && txcnt != null && (txcnt as number) > 0) feat.nvt = (mktcap as number) / (txcnt as number);
    // attach LAGGED: this day's value is only KNOWN ONCHAIN_LAG_DAYS later
    out.set(series.t[i] + lagMs, feat);
  }
  return out;
}
