// Bulk historical data from data.binance.vision — Binance's public archive CDN.
// NOT geo-blocked (unlike the live API). Monthly ZIPs of USDT-M perp klines and
// funding rates. Used for backfill; the live tail comes from OKX.

import { unzipSync } from "fflate";

const BASE = "https://data.binance.vision/data/futures/um/monthly";
const SPOT_BASE = "https://data.binance.vision/data/spot/monthly";
// OI / long-short metrics live ONLY under the DAILY futures path (no monthly file).
const METRICS_BASE = "https://data.binance.vision/data/futures/um/daily/metrics";

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

/** Fetch a list of month archive URLs in bounded-concurrency batches, preserving
 *  the input order in the returned CSV array (null = missing/404). */
async function fetchMonthlyCsvs(urls: string[]): Promise<(string | null)[]> {
  const concurrency = Number(process.env.VISION_KLINES_CONCURRENCY ?? 8);
  const out: (string | null)[] = new Array(urls.length).fill(null);
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch: Promise<void>[] = [];
    for (let j = i; j < Math.min(i + concurrency, urls.length); j++) {
      batch.push(fetchZipCsv(urls[j]).then((csv) => { out[j] = csv; }).catch(() => { out[j] = null; }));
    }
    await Promise.all(batch);
  }
  return out;
}

/** Download monthly kline archives covering [fromTs, toTs]. Skips missing months (pre-listing). */
export async function visionKlines(
  symbol: string, tf: string, fromTs: number, toTs: number, log?: (m: string) => void,
): Promise<KlineRow[]> {
  const rows: KlineRow[] = [];
  const list = Array.from(months(fromTs, toTs));
  const urls = list.map(({ y, m }) => `${BASE}/klines/${sym(symbol)}/${tf}/${sym(symbol)}-${tf}-${y}-${String(m).padStart(2, "0")}.zip`);
  const csvs = await fetchMonthlyCsvs(urls);
  for (let mi = 0; mi < list.length; mi++) {
    const csv = csvs[mi];
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
    log?.(`vision ${symbol} ${list[mi].y}-${String(list[mi].m).padStart(2, "0")}: ${count} bars`);
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

// ============================================================ WAVE-3a additions

/** SPOT klines (for perp-spot basis). Same archive root, spot path. Skips missing months. */
export async function visionSpotKlines(
  symbol: string, tf: string, fromTs: number, toTs: number, log?: (m: string) => void,
): Promise<KlineRow[]> {
  const rows: KlineRow[] = [];
  const list = Array.from(months(fromTs, toTs));
  const urls = list.map(({ y, m }) => `${SPOT_BASE}/klines/${sym(symbol)}/${tf}/${sym(symbol)}-${tf}-${y}-${String(m).padStart(2, "0")}.zip`);
  const csvs = await fetchMonthlyCsvs(urls);
  let total = 0;
  for (let mi = 0; mi < list.length; mi++) {
    const csv = csvs[mi];
    if (csv === null) continue;
    for (const line of csv.split("\n")) {
      if (!line || !/^\d/.test(line)) continue;
      const p = line.split(",");
      const t = normTs(Number(p[0]));
      if (t < fromTs || t > toTs) continue;
      rows.push({ t, o: Number(p[1]), h: Number(p[2]), l: Number(p[3]), c: Number(p[4]), v: Number(p[5]) });
      total++;
    }
  }
  log?.(`vision SPOT ${symbol}: ${total} bars`);
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

function* days(fromTs: number, toTs: number): Generator<{ y: number; m: number; d: number }> {
  let t = Date.UTC(new Date(fromTs).getUTCFullYear(), new Date(fromTs).getUTCMonth(), new Date(fromTs).getUTCDate());
  while (t <= toTs) {
    const dd = new Date(t);
    yield { y: dd.getUTCFullYear(), m: dd.getUTCMonth() + 1, d: dd.getUTCDate() };
    t += 86_400_000;
  }
}

export interface MetricsSeries {
  /** open interest (base units) stamps */
  oiT: number[]; oiV: number[];
  /** taker long/short volume ratio stamps */
  lsrT: number[]; lsrR: number[];
}

/**
 * Daily futures METRICS archive: open interest + long/short ratios at ~5min cadence.
 * CSV columns: create_time,symbol,sum_open_interest,sum_open_interest_value,
 *   count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,
 *   count_long_short_ratio,sum_taker_long_short_vol_ratio
 * We persist sum_open_interest (col 2, base units) and sum_taker_long_short_vol_ratio
 * (col 7, the taker flow ratio). Missing days (pre-listing) are skipped.
 * create_time is "YYYY-MM-DD HH:MM:SS" UTC.
 */
export async function visionMetrics(
  symbol: string, fromTs: number, toTs: number, log?: (m: string) => void,
): Promise<MetricsSeries> {
  // The metrics archive is DAILY (one zip per day), so a multi-year backfill is
  // thousands of small fetches. Fetch in bounded-concurrency batches and parse in
  // chronological order so the appended stamp series stays sorted.
  const allDays = Array.from(days(fromTs, toTs));
  const concurrency = Number(process.env.VISION_METRICS_CONCURRENCY ?? 16);
  const parsed: { ts: number; oi: number; lsr: number }[][] = new Array(allDays.length);
  let okDays = 0, missingDays = 0;

  const fetchDay = async (idx: number) => {
    const { y, m, d } = allDays[idx];
    const mm = String(m).padStart(2, "0"), dd = String(d).padStart(2, "0");
    const url = `${METRICS_BASE}/${sym(symbol)}/${sym(symbol)}-metrics-${y}-${mm}-${dd}.zip`;
    let csv: string | null;
    try { csv = await fetchZipCsv(url); }
    catch (err) { log?.(`vision metrics ${symbol} ${y}-${mm}-${dd} failed: ${err instanceof Error ? err.message.slice(0, 80) : err}`); parsed[idx] = []; return; }
    if (csv === null) { missingDays++; parsed[idx] = []; return; }
    okDays++;
    const rows: { ts: number; oi: number; lsr: number }[] = [];
    for (const line of csv.split("\n")) {
      if (!line || line.startsWith("create_time")) continue;
      const p = line.split(",");
      if (p.length < 8) continue;
      const ts = Date.parse(p[0].replace(" ", "T") + "Z"); // "YYYY-MM-DD HH:MM:SS" UTC
      if (!Number.isFinite(ts) || ts < fromTs || ts > toTs) continue;
      rows.push({ ts, oi: Number(p[2]), lsr: Number(p[7]) });
    }
    parsed[idx] = rows;
  };

  for (let i = 0; i < allDays.length; i += concurrency) {
    const batch: Promise<void>[] = [];
    for (let j = i; j < Math.min(i + concurrency, allDays.length); j++) batch.push(fetchDay(j));
    await Promise.all(batch);
  }

  const oiT: number[] = [], oiV: number[] = [], lsrT: number[] = [], lsrR: number[] = [];
  for (let i = 0; i < parsed.length; i++) {
    for (const r of parsed[i] ?? []) {
      if (Number.isFinite(r.oi)) { oiT.push(r.ts); oiV.push(r.oi); }
      if (Number.isFinite(r.lsr)) { lsrT.push(r.ts); lsrR.push(r.lsr); }
    }
  }
  if (okDays || missingDays) log?.(`vision metrics ${symbol}: ${okDays} days, ${oiV.length} OI + ${lsrR.length} LSR stamps (${missingDays} missing days)`);
  return { oiT, oiV, lsrT, lsrR };
}
