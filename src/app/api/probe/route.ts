// Data-source reachability probe. Vercel functions run in US East, same geo
// situation as Trigger.dev workers — this tells us which providers work there.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const PROBES: { name: string; url: string }[] = [
  { name: "binance-fapi", url: "https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=2" },
  { name: "binance-spot", url: "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2" },
  { name: "bybit-linear", url: "https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=60&limit=2" },
  { name: "bybit-funding", url: "https://api.bybit.com/v5/market/funding/history?category=linear&symbol=BTCUSDT&limit=2" },
  { name: "okx", url: "https://www.okx.com/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=1H&limit=2" },
  { name: "binance-vision", url: "https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2024-01.zip" },
];

export async function GET() {
  const results: Record<string, string> = {};
  await Promise.all(PROBES.map(async (p) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const resp = await fetch(p.url, { method: p.name === "binance-vision" ? "HEAD" : "GET", signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      const body = p.name === "binance-vision" ? "" : (await resp.text()).slice(0, 80);
      results[p.name] = `${resp.status}${resp.ok ? " OK" : ` ${body}`}`;
    } catch (err) {
      results[p.name] = `ERR ${err instanceof Error ? err.message.slice(0, 60) : err}`;
    }
  }));
  return NextResponse.json(results);
}
