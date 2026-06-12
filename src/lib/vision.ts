// Bulk historical data from data.binance.vision — Binance's public archive CDN.
// NOT geo-blocked (unlike the live API). Monthly ZIPs of USDT-M perp klines and
// funding rates. Used for backfill; the live tail comes from OKX.

import { unzipSync } from "fflate";

const BASE = "https://data.binance.vision/data/futures/um/monthly";

function sym(symbol: string): string { return symbol.replace("/", ""); }

async function fetchZipCsv(url: string): Promise<string | null> {
  const resp = await fetch(url);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`vision ${resp.status} ${url.slice(-60)}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  const files = unzipSync(buf);
  const name = Object.keys(files)[0];
  return new TextDecoder().decode(files[name]);
}

function* months(fromTs: number, toTs: number): Generator<{ y: number; m: number }> {
  const d = new Date(fromTs);
  let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const end = new Date(toTs);
  const endY = end.getUTCFullYear(), endM = end.getUTCMonth() + 1;
  while (y < endY || (y === endY && m <= endM)) {
    yield { y, m };
    m++; if (m > 12) { m = 1; y++; }
  }
}

function normTs(x: number): number {
  // vision switched some files to microsecond timestamps
  return x > 1e14 ? Math.floor(x / 1000) : x;
}

export interface KlineRow { t: number; o: number; h: number; l: number; c: number; v: number }

/** Download monthly kline archives covering [fromTs, toTs]. Skips missing months (pre-listing). */
export async function visionKlines(
  symbol: string, tf: string, fromTs: number, toTs: number, log?: (m: string) => void,
): Promise<KlineRow[]> {
  const rows: KlineRow[] = [];
  for (const { y, m } of months(fromTs, toTs)) {
    const mm = String(m).padStart(2, "0");
    const url = `${BASE}/klines/${sym(symbol)}/${tf}/${sym(symbol)}-${tf}-${y}-${mm}.zip`;
    const csv = await fetchZipCsv(url);
    if (csv === null) continue; // not listed yet / current month
    let count = 0;
    for (const line of csv.split("\n")) {
      if (!line || !/^\d/.test(line)) continue; // skip header/blank
      const p = line.split(",");
      const t = normTs(Number(p[0]));
      if (t < fromTs || t > toTs) continue;
      rows.push({ t, o: Number(p[1]), h: Number(p[2]), l: Number(p[3]), c: Number(p[4]), v: Number(p[5]) });
      count++;
    }
    log?.(`vision ${symbol} ${y}-${mm}: ${count} bars`);
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

/** Monthly funding-rate archives. CSV: calc_time, funding_interval_hours, last_funding_rate */
export async function visionFunding(
  symbol: string, fromTs: number, toTs: number, log?: (m: string) => void,
): Promise<{ t: number[]; r: number[] }> {
  const t: number[] = [], r: number[] = [];
  for (const { y, m } of months(fromTs, toTs)) {
    const mm = String(m).padStart(2, "0");
    const url = `${BASE}/fundingRate/${sym(symbol)}/${sym(symbol)}-fundingRate-${y}-${mm}.zip`;
    try {
      const csv = await fetchZipCsv(url);
      if (csv === null) continue;
      for (const line of csv.split("\n")) {
        if (!line || !/^\d/.test(line)) continue;
        const p = line.split(",");
        const ts = normTs(Number(p[0]));
        if (ts < fromTs || ts > toTs) continue;
        t.push(ts); r.push(Number(p[2]));
      }
    } catch (err) {
      log?.(`vision funding ${symbol} ${y}-${mm} failed: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
    }
  }
  return { t, r };
}
