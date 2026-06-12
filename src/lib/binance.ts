// Market data with provider chain: Binance USDT-M perp -> Binance spot -> Bybit
// linear perp. Binance 451-blocks US datacenter IPs (Trigger.dev workers);
// Bybit serves them, so cloud workers transparently land on Bybit while the
// same code on EU hosts uses Binance.

import { bybitFunding, bybitKlines, bybitLastPrice } from "./bybit";

const FAPI = "https://fapi.binance.com";
const SPOT = "https://api.binance.com";

export function binSymbol(symbol: string): string {
  return symbol.replace("/", "");
}

interface KlineRow { t: number; o: number; h: number; l: number; c: number; v: number }

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url, { headers: { "User-Agent": "finance-engine-v2" } });
  if (!resp.ok) throw new Error(`${resp.status} ${url.slice(0, 120)}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

async function fetchKlinesPage(base: string, path: string, symbol: string, interval: string, startTime: number, limit: number): Promise<KlineRow[]> {
  const raw = await fetchJson(`${base}${path}?symbol=${binSymbol(symbol)}&interval=${interval}&startTime=${startTime}&limit=${limit}`) as unknown[][];
  return raw.map((r) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) }));
}

/** Paginate klines [startTime, endTime). Chain: binance perp -> binance spot -> bybit perp. */
export async function fetchKlines(
  symbol: string, interval: string, startTime: number, endTime: number,
  log?: (m: string) => void,
): Promise<{ rows: KlineRow[]; source: "perp" | "spot" | "bybit" }> {
  const tryFetch = async (base: string, path: string, src: "perp" | "spot") => {
    const rows: KlineRow[] = [];
    let cursor = startTime;
    let pages = 0;
    while (cursor < endTime) {
      const page = await fetchKlinesPage(base, path, symbol, interval, cursor, src === "perp" ? 1500 : 1000);
      if (!page.length) break;
      for (const r of page) if (r.t < endTime) rows.push(r);
      const last = page[page.length - 1].t;
      if (last <= cursor) break;
      cursor = last + 1;
      pages++;
      if (pages % 20 === 0) log?.(`${symbol} ${interval}: ${rows.length} bars...`);
      if (pages > 600) break; // safety
    }
    return { rows, source: src };
  };
  try {
    return await tryFetch(FAPI, "/fapi/v1/klines", "perp");
  } catch (err) {
    log?.(`fapi failed (${err instanceof Error ? err.message.slice(0, 100) : err}); falling back to spot`);
    try {
      return await tryFetch(SPOT, "/api/v3/klines", "spot");
    } catch (err2) {
      log?.(`spot failed (${err2 instanceof Error ? err2.message.slice(0, 100) : err2}); falling back to bybit`);
      const rows = await bybitKlines(symbol, interval, startTime, endTime, log);
      return { rows, source: "bybit" as const };
    }
  }
}

/** Funding rate history (8h cadence), paginated. Binance -> Bybit. Empty if unavailable. */
export async function fetchFunding(
  symbol: string, startTime: number, endTime: number, log?: (m: string) => void,
): Promise<{ t: number[]; r: number[] }> {
  const t: number[] = [], r: number[] = [];
  try {
    let cursor = startTime;
    let pages = 0;
    while (cursor < endTime && pages < 200) {
      const raw = await fetchJson(`${FAPI}/fapi/v1/fundingRate?symbol=${binSymbol(symbol)}&startTime=${cursor}&endTime=${endTime}&limit=1000`) as { fundingTime: number; fundingRate: string }[];
      if (!raw.length) break;
      for (const row of raw) { t.push(Number(row.fundingTime)); r.push(Number(row.fundingRate)); }
      const last = Number(raw[raw.length - 1].fundingTime);
      if (last <= cursor) break;
      cursor = last + 1;
      pages++;
    }
  } catch (err) {
    log?.(`binance funding unavailable for ${symbol}: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
    return bybitFunding(symbol, startTime, endTime, log);
  }
  return { t, r };
}

/** Latest mark/last price (for paper fills). */
export async function fetchLastPrice(symbol: string): Promise<number> {
  try {
    const d = await fetchJson(`${FAPI}/fapi/v1/ticker/price?symbol=${binSymbol(symbol)}`) as { price: string };
    return Number(d.price);
  } catch {
    try {
      const d = await fetchJson(`${SPOT}/api/v3/ticker/price?symbol=${binSymbol(symbol)}`) as { price: string };
      return Number(d.price);
    } catch {
      return bybitLastPrice(symbol);
    }
  }
}
