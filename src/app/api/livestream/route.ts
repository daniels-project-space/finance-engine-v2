// Live STREAMING price feed for the Watch page — 1-minute BTC candles + the latest
// tick from the OKX public API (no key; reachable from Vercel per /api/probe). The
// client polls this every couple of seconds so the right-most candle visibly moves.
// Read-only, no engine/R2/auth touch.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Candle = { t: number; o: number; h: number; l: number; c: number };

async function okxCandles(instId: string, limit = 180): Promise<Candle[] | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const resp = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=1m&limit=${limit}`, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const j = await resp.json() as { data?: string[][] };
    if (!Array.isArray(j.data)) return null;
    const rows = [...j.data].reverse();   // OKX is newest-first -> chronological
    const out: Candle[] = [];
    for (const r of rows) {
      const t = Number(r[0]), o = Number(r[1]), h = Number(r[2]), l = Number(r[3]), c = Number(r[4]);
      if ([t, o, h, l, c].every(Number.isFinite) && c > 0) out.push({ t, o, h, l, c });
    }
    return out.length > 1 ? out : null;
  } catch { return null; }
}

async function okxLast(instId: string): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const resp = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const j = await resp.json() as { data?: { last?: string }[] };
    const last = Number(j.data?.[0]?.last);
    return Number.isFinite(last) && last > 0 ? last : null;
  } catch { return null; }
}

export async function GET() {
  const [candles, last] = await Promise.all([okxCandles("BTC-USDT"), okxLast("BTC-USDT")]);
  // fold the freshest tick into the forming candle so the bar moves between minute closes
  if (candles && last && candles.length) {
    const cur = candles[candles.length - 1];
    cur.c = last; cur.h = Math.max(cur.h, last); cur.l = Math.min(cur.l, last);
  }
  return NextResponse.json({ candles, last, ts: Date.now() }, { headers: { "cache-control": "no-store" } });
}
