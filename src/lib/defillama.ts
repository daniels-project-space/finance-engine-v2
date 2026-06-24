// DefiLlama — FREE, keyless, commercially clean. Aggregate stablecoin supply
// (total circulating USD) as a macro-liquidity feature: rising stablecoin supply
// = dry powder / risk-on liquidity entering crypto. Daily, global (not per-coin).
//
// POINT-IN-TIME: stablecoin supply is a slow daily series; we lag by 1 day to
// match the on-chain publication discipline (probed in smoke).

import { getJsonGz, putJsonGz } from "./storage";

export const STABLE_LAG_DAYS = 1;
const URL = "https://stablecoins.llama.fi/stablecoincharts/all";
export const STABLE_KEY = "onchain/stablesupply.json.gz";

export interface StableSeries { t: number[]; usd: number[] }

/** Backfill/refresh total stablecoin circulating USD; persist to R2. */
export async function ingestStablecoins(log?: (m: string) => void): Promise<StableSeries> {
  let rows: { date: string; totalCirculatingUSD?: { peggedUSD?: number } }[] = [];
  try {
    const resp = await fetch(URL, { headers: { "User-Agent": "finance-engine-v2" } });
    if (!resp.ok) throw new Error(`defillama ${resp.status}`);
    rows = await resp.json() as typeof rows;
  } catch (e) { log?.(`defillama fetch failed: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
  const byDay = new Map<number, number>();
  for (const r of rows) {
    const ts = Number(r.date) * 1000;
    const day = Math.floor(ts / 86400000) * 86400000;
    const usd = r.totalCirculatingUSD?.peggedUSD;
    if (usd != null && Number.isFinite(usd)) byDay.set(day, usd);
  }
  const t = [...byDay.keys()].sort((a, b) => a - b);
  const series: StableSeries = { t, usd: t.map((d) => byDay.get(d)!) };
  await putJsonGz(STABLE_KEY, series);
  log?.(`stablesupply: ${t.length} days, ${t.length ? new Date(t[0]).toISOString().slice(0, 10) : "-"} -> ${t.length ? new Date(t[t.length - 1]).toISOString().slice(0, 10) : "-"}, last=$${t.length ? (byDay.get(t[t.length - 1])! / 1e9).toFixed(1) + "B" : "-"}`);
  return series;
}

export async function loadStablecoins(): Promise<StableSeries | null> {
  return getJsonGz<StableSeries>(STABLE_KEY);
}

/** Day-start -> stablecoin-supply map, LAGGED by STABLE_LAG_DAYS (point-in-time). */
export function stableMap(series: StableSeries): Map<number, number> {
  const m = new Map<number, number>();
  const lagMs = STABLE_LAG_DAYS * 86400000;
  for (let i = 0; i < series.t.length; i++) m.set(series.t[i] + lagMs, series.usd[i]);
  return m;
}
