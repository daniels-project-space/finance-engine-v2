// S&P 500 benchmark series (Stooq free CSV — no key, no geo-block).
// Stored in Convex config as {t: ms[], c: close[]} for dashboard overlays.

export interface Benchmark { t: number[]; c: number[] }

export async function fetchSpx(log?: (m: string) => void): Promise<Benchmark | null> {
  try {
    const resp = await fetch("https://stooq.com/q/d/l/?s=%5Espx&i=d", { headers: { "User-Agent": "finance-engine-v2" } });
    if (!resp.ok) throw new Error(`stooq ${resp.status}`);
    const csv = await resp.text();
    const t: number[] = [], c: number[] = [];
    const cutoff = Date.now() - 6 * 365 * 86_400_000;
    for (const line of csv.split("\n").slice(1)) {
      const p = line.split(",");
      if (p.length < 5) continue;
      const ts = Date.parse(p[0]);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const close = Number(p[4]);
      if (!Number.isFinite(close)) continue;
      t.push(ts); c.push(close);
    }
    if (t.length < 200) throw new Error(`only ${t.length} rows`);
    // downsample to ~420 points
    const step = Math.max(1, Math.floor(t.length / 420));
    const dt: number[] = [], dc: number[] = [];
    for (let i = 0; i < t.length; i += step) { dt.push(t[i]); dc.push(c[i]); }
    if (dt[dt.length - 1] !== t[t.length - 1]) { dt.push(t[t.length - 1]); dc.push(c[c.length - 1]); }
    return { t: dt, c: dc };
  } catch (err) {
    log?.(`spx benchmark fetch failed: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
    return null;
  }
}
