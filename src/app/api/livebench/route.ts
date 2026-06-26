// Read-only HOURLY benchmark for the Live chart. The daily benchmark_btc/_spx
// series are too sparse for a window that's only a few hours/days long, so the
// live BTC/SOL overlay would draw nothing. This fetches recent BTC + SOL 1h closes
// from the OKX public API (no key needed; reachable from Vercel per /api/probe) so
// the live chart can always show a real "your strategy vs holding BTC/SOL" line.
// No engine touch, no R2, no auth.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function okx1h(instId: string): Promise<{ t: number[]; c: number[] } | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    // 300 hourly bars ~= 12.5 days, plenty to cover the live window
    const resp = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=1H&limit=300`, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const j = await resp.json() as { data?: string[][] };
    if (!Array.isArray(j.data)) return null;
    // OKX returns newest-first; reverse to chronological. [ts,o,h,l,c,...]
    const rows = [...j.data].reverse();
    const t: number[] = [], c: number[] = [];
    for (const r of rows) {
      const ts = Number(r[0]), close = Number(r[4]);
      if (Number.isFinite(ts) && Number.isFinite(close) && close > 0) { t.push(ts); c.push(close); }
    }
    return t.length > 1 ? { t, c } : null;
  } catch { return null; }
}

export async function GET() {
  const [btc, sol] = await Promise.all([okx1h("BTC-USDT"), okx1h("SOL-USDT")]);
  return NextResponse.json({ btc, sol }, { headers: { "cache-control": "public, max-age=120" } });
}
