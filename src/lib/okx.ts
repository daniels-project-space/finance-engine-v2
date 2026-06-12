// OKX public market data — the live-tail provider (reachable from US cloud,
// where Binance and Bybit geo-block). USDT perpetual swaps.

const BASE = "https://www.okx.com";

const BAR: Record<string, string> = { "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1Dutc" };

function instId(symbol: string): string {
  return `${symbol.replace("/", "-")}-SWAP`;
}

async function fetchJson(url: string): Promise<unknown[]> {
  const resp = await fetch(url, { headers: { "User-Agent": "finance-engine-v2" } });
  if (!resp.ok) throw new Error(`okx ${resp.status} ${url.slice(0, 110)}`);
  const data = await resp.json() as { code: string; msg: string; data: unknown[] };
  if (data.code !== "0") throw new Error(`okx code ${data.code}: ${data.msg}`);
  return data.data;
}

export interface KlineRow { t: number; o: number; h: number; l: number; c: number; v: number }

/** Closed candles in [fromTs, toTs]. Pages backwards via history-candles when needed. */
export async function okxKlines(
  symbol: string, tf: string, fromTs: number, toTs: number, log?: (m: string) => void,
): Promise<KlineRow[]> {
  const bar = BAR[tf];
  if (!bar) throw new Error(`okx: unsupported tf ${tf}`);
  const id = instId(symbol);
  const out = new Map<number, KlineRow>();
  // recent window first (newest 300)
  const parse = (rows: unknown[]) => {
    for (const raw of rows as string[][]) {
      const t = Number(raw[0]);
      const confirmed = raw[raw.length - 1] === "1";
      if (!confirmed || t < fromTs || t > toTs) continue;
      out.set(t, { t, o: Number(raw[1]), h: Number(raw[2]), l: Number(raw[3]), c: Number(raw[4]), v: Number(raw[5]) });
    }
  };
  const recent = await fetchJson(`${BASE}/api/v5/market/candles?instId=${id}&bar=${bar}&limit=300`);
  parse(recent);
  // page backwards if we still need older bars
  let oldest = recent.length ? Math.min(...(recent as string[][]).map((r) => Number(r[0]))) : toTs;
  let pages = 0;
  while (oldest > fromTs && pages < 120) {
    const older = await fetchJson(`${BASE}/api/v5/market/history-candles?instId=${id}&bar=${bar}&after=${oldest}&limit=100`);
    if (!older.length) break;
    parse(older);
    const newOldest = Math.min(...(older as string[][]).map((r) => Number(r[0])));
    if (newOldest >= oldest) break;
    oldest = newOldest;
    pages++;
    if (pages % 20 === 0) log?.(`okx ${symbol}: paged back to ${new Date(oldest).toISOString()}`);
  }
  return Array.from(out.values()).sort((a, b) => a.t - b.t);
}

/** Funding history in [fromTs, toTs], paged backwards. */
export async function okxFunding(
  symbol: string, fromTs: number, toTs: number, log?: (m: string) => void,
): Promise<{ t: number[]; r: number[] }> {
  const id = instId(symbol);
  const acc = new Map<number, number>();
  try {
    let after = toTs + 1;
    for (let pages = 0; pages < 60; pages++) {
      const rows = await fetchJson(`${BASE}/api/v5/public/funding-rate-history?instId=${id}&after=${after}&limit=100`) as { fundingTime: string; fundingRate: string }[];
      if (!rows.length) break;
      let oldest = Infinity;
      for (const row of rows) {
        const ts = Number(row.fundingTime);
        oldest = Math.min(oldest, ts);
        if (ts >= fromTs && ts <= toTs) acc.set(ts, Number(row.fundingRate));
      }
      if (oldest <= fromTs || !Number.isFinite(oldest)) break;
      after = oldest;
    }
  } catch (err) {
    log?.(`okx funding unavailable for ${symbol}: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
  }
  const t = Array.from(acc.keys()).sort((a, b) => a - b);
  return { t, r: t.map((ts) => acc.get(ts) as number) };
}

export async function okxLastPrice(symbol: string): Promise<number> {
  const rows = await fetchJson(`${BASE}/api/v5/market/ticker?instId=${instId(symbol)}`) as { last: string }[];
  return Number(rows[0].last);
}
