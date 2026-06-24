// Benchmark series for dashboard overlays.
// SPX — Primary: FRED CSV (keyless, stable). Fallback: Yahoo v8 chart JSON.
// BTC buy-and-hold — built from the engine's own ingested BTC/USDT 1d closes.
// Both stored in Convex config as {t: ms[], c: close[]}.

export interface Benchmark { t: number[]; c: number[] }

function downsample(t: number[], c: number[], maxPts = 420): Benchmark {
  const step = Math.max(1, Math.floor(t.length / maxPts));
  const dt: number[] = [], dc: number[] = [];
  for (let i = 0; i < t.length; i += step) { dt.push(t[i]); dc.push(c[i]); }
  if (dt[dt.length - 1] !== t[t.length - 1]) { dt.push(t[t.length - 1]); dc.push(c[c.length - 1]); }
  return { t: dt, c: dc };
}

async function fromFred(): Promise<Benchmark> {
  const resp = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500", { headers: { "User-Agent": "finance-engine-v2" } });
  if (!resp.ok) throw new Error(`fred ${resp.status}`);
  const csv = await resp.text();
  const t: number[] = [], c: number[] = [];
  const cutoff = Date.now() - 6 * 365 * 86_400_000;
  for (const line of csv.split("\n").slice(1)) {
    const [d, v] = line.trim().split(",");
    const ts = Date.parse(d);
    // FRED emits an empty value field for market holidays (e.g. "2022-05-30,").
    // Number("") === 0, which would pass an isFinite check and poison rebasing —
    // so reject anything that isn't a positive close.
    if (v === undefined || v === "" || v === ".") continue;
    const close = Number(v);
    if (!Number.isFinite(ts) || !Number.isFinite(close) || close <= 0 || ts < cutoff) continue;
    t.push(ts); c.push(close);
  }
  if (t.length < 200) throw new Error(`fred only ${t.length} rows`);
  return downsample(t, c);
}

async function fromYahoo(): Promise<Benchmark> {
  const resp = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=6y&interval=1d", { headers: { "User-Agent": "Mozilla/5.0 (finance-engine-v2)" } });
  if (!resp.ok) throw new Error(`yahoo ${resp.status}`);
  const data = await resp.json() as { chart: { result: { timestamp: number[]; indicators: { quote: { close: (number | null)[] }[] } }[] } };
  const r = data.chart.result[0];
  const t: number[] = [], c: number[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const close = r.indicators.quote[0].close[i];
    if (close == null || !Number.isFinite(close) || close <= 0) continue;
    t.push(r.timestamp[i] * 1000); c.push(close);
  }
  if (t.length < 200) throw new Error(`yahoo only ${t.length} rows`);
  return downsample(t, c);
}

export async function fetchSpx(log?: (m: string) => void): Promise<Benchmark | null> {
  try { return await fromFred(); } catch (e1) {
    log?.(`fred failed (${e1 instanceof Error ? e1.message : e1}); trying yahoo`);
    try { return await fromYahoo(); } catch (e2) {
      log?.(`spx benchmark unavailable: ${e2 instanceof Error ? e2.message.slice(0, 100) : e2}`);
      return null;
    }
  }
}

/**
 * BTC buy-and-hold benchmark from the engine's own ingested 1d closes.
 * No external source — same {t, c} shape and 6-year window as SPX, so the
 * dashboard can rebase it to any chart period exactly like the SPX overlay.
 */
export function buildBtcBenchmark(bars: { t: number[]; c: number[] } | null): Benchmark | null {
  if (!bars || !bars.t?.length) return null;
  const cutoff = Date.now() - 6 * 365 * 86_400_000;
  const t: number[] = [], c: number[] = [];
  for (let i = 0; i < bars.t.length; i++) {
    const ts = bars.t[i], close = bars.c[i];
    if (!Number.isFinite(ts) || !Number.isFinite(close) || close <= 0 || ts < cutoff) continue;
    t.push(ts); c.push(close);
  }
  if (t.length < 50) return null;
  return downsample(t, c);
}
