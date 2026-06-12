// Bybit v5 public market data — fallback provider when Binance geo-blocks
// the worker region (Trigger.dev US workers get 451 from Binance).
// USDT linear perps: klines + funding history. NOTE: v5 returns NEWEST FIRST.

const BASE = "https://api.bybit.com";

const INTERVAL: Record<string, string> = { "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" };
const TF_MS: Record<string, number> = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

function bybitSymbol(symbol: string): string {
  return symbol.replace("/", "");
}

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url, { headers: { "User-Agent": "finance-engine-v2" } });
  if (!resp.ok) throw new Error(`bybit ${resp.status} ${url.slice(0, 110)}: ${(await resp.text()).slice(0, 160)}`);
  const data = await resp.json() as { retCode: number; retMsg: string; result?: unknown };
  if (data.retCode !== 0) throw new Error(`bybit retCode ${data.retCode}: ${data.retMsg}`);
  return data.result;
}

export interface KlineRow { t: number; o: number; h: number; l: number; c: number; v: number }

export async function bybitKlines(
  symbol: string, tf: string, startTime: number, endTime: number, log?: (m: string) => void,
): Promise<KlineRow[]> {
  const interval = INTERVAL[tf];
  const tfMs = TF_MS[tf];
  if (!interval) throw new Error(`bybit: unsupported tf ${tf}`);
  const rows: KlineRow[] = [];
  let cursor = startTime;
  let pages = 0;
  while (cursor < endTime && pages < 700) {
    const windowEnd = Math.min(cursor + 1000 * tfMs - 1, endTime);
    const result = await fetchJson(
      `${BASE}/v5/market/kline?category=linear&symbol=${bybitSymbol(symbol)}&interval=${interval}&start=${cursor}&end=${windowEnd}&limit=1000`,
    ) as { list: string[][] };
    const list = result.list ?? [];
    if (!list.length) {
      // no data in this window (instrument may not exist yet) — jump forward
      cursor = windowEnd + 1;
      pages++;
      continue;
    }
    // newest first -> reverse
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      const t = Number(r[0]);
      if (t < cursor || t > endTime) continue;
      rows.push({ t, o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) });
    }
    cursor = windowEnd + 1;
    pages++;
    if (pages % 20 === 0) log?.(`bybit ${symbol} ${tf}: ${rows.length} bars...`);
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

export async function bybitFunding(
  symbol: string, startTime: number, endTime: number, log?: (m: string) => void,
): Promise<{ t: number[]; r: number[] }> {
  const t: number[] = [], r: number[] = [];
  try {
    // 8h cadence, 200/page, newest-first; walk windows of 200*8h
    const windowMs = 200 * 8 * 3_600_000;
    let cursor = startTime;
    let pages = 0;
    while (cursor < endTime && pages < 400) {
      const windowEnd = Math.min(cursor + windowMs - 1, endTime);
      const result = await fetchJson(
        `${BASE}/v5/market/funding/history?category=linear&symbol=${bybitSymbol(symbol)}&startTime=${cursor}&endTime=${windowEnd}&limit=200`,
      ) as { list: { fundingRate: string; fundingRateTimestamp: string }[] };
      const list = result.list ?? [];
      for (let i = list.length - 1; i >= 0; i--) {
        const ts = Number(list[i].fundingRateTimestamp);
        if (ts >= cursor && ts <= endTime) { t.push(ts); r.push(Number(list[i].fundingRate)); }
      }
      cursor = windowEnd + 1;
      pages++;
    }
  } catch (err) {
    log?.(`bybit funding unavailable for ${symbol}: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
  }
  return { t, r };
}

export async function bybitLastPrice(symbol: string): Promise<number> {
  const result = await fetchJson(`${BASE}/v5/market/tickers?category=linear&symbol=${bybitSymbol(symbol)}`) as { list: { lastPrice: string }[] };
  return Number(result.list[0].lastPrice);
}
