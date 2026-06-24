// OKX public market data via CCXT (migrated from the bespoke REST glue, 2026-06-24).
// USDT perpetual swaps. Live-tail provider (reachable from US cloud where Binance
// and Bybit geo-block). Same public interface as the old hand-rolled module
// (okxKlines / okxFunding / okxLastPrice) so callers are unchanged.
//
// VOLUME UNIT: ccxt returns OKX OHLCV volume in BASE units (= okx raw volCcy =
// raw[5] contracts * contractSize). The old glue used raw[5] (CONTRACT units), and
// the liquidity/size flavors + any volume signal depend on that exact unit. So we
// CONVERT ccxt volume back to contracts via `/ contractSize` (sourced per-symbol
// from ccxt market metadata — NOT hardcoded). Verified per-coin to match the old
// numbers exactly (scripts/ccxt parity).

import ccxt from "ccxt";

type Okx = InstanceType<typeof ccxt.okx>;

const BAR: Record<string, string> = { "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };

// single shared OKX client with markets loaded once (contractSize lookup).
let _ex: Okx | null = null;
let _marketsLoaded = false;
async function okxClient(): Promise<Okx> {
  if (!_ex) _ex = new ccxt.okx({ enableRateLimit: true });
  if (!_marketsLoaded) { await _ex.loadMarkets(); _marketsLoaded = true; }
  return _ex;
}

/** Unified ccxt swap symbol for a "BTC/USDT" perp. */
function swapSymbol(symbol: string): string { return `${symbol}:USDT`; }
/** Unified ccxt spot symbol. */
function spotSymbol(symbol: string): string { return symbol; }

/** contractSize for a swap symbol (per-coin; from ccxt market metadata). 1 if absent. */
async function contractSize(ex: Okx, ccxtSym: string): Promise<number> {
  try { const m = ex.market(ccxtSym); const cs = (m as { contractSize?: number }).contractSize; return cs && cs > 0 ? cs : 1; }
  catch { return 1; }
}

export interface KlineRow { t: number; o: number; h: number; l: number; c: number; v: number }

/**
 * Closed candles in [fromTs, toTs]. Pages forward via ccxt.fetchOHLCV (which
 * handles OKX's history endpoint + pagination). Volume converted to CONTRACT
 * units (/ contractSize) to match the legacy okx.ts numbers exactly.
 * `kind` selects perp (default) vs spot — spot has no contractSize (=1).
 */
export async function okxKlines(
  symbol: string, tf: string, fromTs: number, toTs: number, log?: (m: string) => void, kind: "swap" | "spot" = "swap",
): Promise<KlineRow[]> {
  const bar = BAR[tf];
  if (!bar) throw new Error(`okx: unsupported tf ${tf}`);
  const ex = await okxClient();
  const ccxtSym = kind === "spot" ? spotSymbol(symbol) : swapSymbol(symbol);
  const cs = kind === "spot" ? 1 : await contractSize(ex, ccxtSym);
  const tfMs = ex.parseTimeframe(bar) * 1000;
  const out = new Map<number, KlineRow>();
  let since = fromTs;
  let pages = 0;
  try {
    while (since <= toTs && pages < 200) {
      const rows = await ex.fetchOHLCV(ccxtSym, bar, since, 300);
      if (!rows.length) break;
      for (const r of rows) {
        const t = r[0]!;
        if (t < fromTs || t > toTs) continue;
        // exclude the in-progress (unclosed) bar: its open time + tf must be <= now
        if (t + tfMs > Date.now()) continue;
        out.set(t, { t, o: r[1]!, h: r[2]!, l: r[3]!, c: r[4]!, v: (r[5] ?? 0) / cs });
      }
      const last = rows[rows.length - 1]![0]!;
      if (last < since + tfMs) break; // no forward progress
      since = last + tfMs;
      pages++;
      if (pages % 20 === 0) log?.(`okx ${symbol}: paged to ${new Date(since).toISOString()}`);
    }
  } catch (err) {
    log?.(`okx klines error ${symbol}: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
  }
  return Array.from(out.values()).sort((a, b) => a.t - b.t);
}

/** Funding history in [fromTs, toTs] via ccxt.fetchFundingRateHistory. */
export async function okxFunding(
  symbol: string, fromTs: number, toTs: number, log?: (m: string) => void,
): Promise<{ t: number[]; r: number[] }> {
  const ex = await okxClient();
  const ccxtSym = swapSymbol(symbol);
  const acc = new Map<number, number>();
  try {
    let since = fromTs;
    for (let pages = 0; pages < 80; pages++) {
      const rows = await ex.fetchFundingRateHistory(ccxtSym, since, 100);
      if (!rows.length) break;
      let newest = since;
      for (const row of rows) {
        const t = row.timestamp!;
        newest = Math.max(newest, t);
        if (t >= fromTs && t <= toTs) acc.set(t, row.fundingRate as number);
      }
      if (newest <= since) break;
      since = newest + 1;
      if (since > toTs) break;
    }
  } catch (err) {
    log?.(`okx funding unavailable for ${symbol}: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
  }
  const t = Array.from(acc.keys()).sort((a, b) => a - b);
  return { t, r: t.map((ts) => acc.get(ts) as number) };
}

export async function okxLastPrice(symbol: string): Promise<number> {
  const ex = await okxClient();
  const tk = await ex.fetchTicker(swapSymbol(symbol));
  return tk.last as number;
}
