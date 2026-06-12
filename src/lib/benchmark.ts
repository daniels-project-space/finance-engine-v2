// S&P 500 benchmark series for dashboard overlays.
// Primary: FRED CSV (keyless, stable). Fallback: Yahoo v8 chart JSON.
// Stored in Convex config as {t: ms[], c: close[]}.

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
    const close = Number(v);
    if (!Number.isFinite(ts) || !Number.isFinite(close) || ts < cutoff) continue;
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
    if (close == null) continue;
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
