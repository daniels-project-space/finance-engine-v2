// Binance USDT-M futures DATA endpoints (open interest + long/short ratio).
//
// LIVE-TAIL provider for the WAVE-3a crypto-native series. The /futures/data/*
// endpoints on fapi.binance.com return ~30 days of recent history (limit<=500),
// so they're the TAIL after the binance.vision daily-metrics archive backfill —
// mirroring how OKX tails the funding archive.
//
// GEO NOTE: the live Binance klines API is 451-blocked from the US Trigger cloud,
// but the /futures/data/* metrics endpoints are reachable from the EU VPS (probed
// 2026-06-15: 200 OK). This module therefore runs on the VPS ingest path only; if
// a future caller hits a block it throws and the caller logs+skips (never fakes).

const BASE = "https://fapi.binance.com";

function sym(symbol: string): string { return symbol.replace("/", ""); }
function period(tf: string): string {
  // Binance data endpoints support 5m,15m,30m,1h,2h,4h,6h,12h,1d
  return ["5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"].includes(tf) ? tf : "1h";
}

async function fetchJson(url: string): Promise<unknown[]> {
  const resp = await fetch(url, { headers: { "User-Agent": "finance-engine-v2" } });
  if (!resp.ok) throw new Error(`binanceFutures ${resp.status} ${url.slice(0, 110)}`);
  return await resp.json() as unknown[];
}

/** Open-interest history (base units), recent tail in [fromTs, toTs]. ~30d max depth. */
export async function binanceOpenInterestHist(
  symbol: string, tf: string, fromTs: number, toTs: number, log?: (m: string) => void,
): Promise<{ t: number[]; v: number[] }> {
  const t: number[] = [], v: number[] = [];
  try {
    const rows = await fetchJson(
      `${BASE}/futures/data/openInterestHist?symbol=${sym(symbol)}&period=${period(tf)}&limit=500`,
    ) as { sumOpenInterest: string; timestamp: number }[];
    for (const row of rows) {
      const ts = Number(row.timestamp);
      if (ts >= fromTs && ts <= toTs) { t.push(ts); v.push(Number(row.sumOpenInterest)); }
    }
  } catch (err) {
    log?.(`binance OI tail unavailable for ${symbol}: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
  }
  return { t, v };
}

/** Taker long/short volume ratio history, recent tail in [fromTs, toTs]. */
export async function binanceLongShortRatio(
  symbol: string, tf: string, fromTs: number, toTs: number, log?: (m: string) => void,
): Promise<{ t: number[]; r: number[] }> {
  const t: number[] = [], r: number[] = [];
  try {
    const rows = await fetchJson(
      `${BASE}/futures/data/takerlongshortRatio?symbol=${sym(symbol)}&period=${period(tf)}&limit=500`,
    ) as { buySellRatio: string; timestamp: number }[];
    for (const row of rows) {
      const ts = Number(row.timestamp);
      if (ts >= fromTs && ts <= toTs) { t.push(ts); r.push(Number(row.buySellRatio)); }
    }
  } catch (err) {
    log?.(`binance LSR tail unavailable for ${symbol}: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
  }
  return { t, r };
}
