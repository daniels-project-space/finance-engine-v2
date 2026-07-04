// Minimal, auditable Binance SPOT client for the live executor. Deliberately a
// thin signed-REST wrapper (no ccxt): every code path that can move money is
// visible in this one file. Spot only — the blend/trend strategies are long-flat
// with weight in [0,1], so no margin, no futures, no withdrawals (the API key
// must have withdrawals disabled regardless).
//
// Binance geo-blocks US IPs (HTTP 451): this client must run from the EU VPS.

import { createHmac } from "node:crypto";

const BASE = process.env.BINANCE_BASE ?? "https://api.binance.com";

export interface Fill { price: number; qty: number; commission: number; commissionAsset: string }
export interface OrderResult {
  orderId: string;
  executedQty: number;       // base asset actually filled
  quoteSpent: number;        // cummulativeQuoteQty
  avgPrice: number;
  fills: Fill[];
  raw: unknown;
}
export interface SymbolFilters { stepSize: number; minQty: number; minNotional: number }

function creds(): { key: string; secret: string } {
  const key = process.env.BINANCE_API_KEY, secret = process.env.BINANCE_API_SECRET;
  if (!key || !secret) throw new Error("BINANCE_API_KEY/SECRET missing");
  return { key, secret };
}

/** "ETH/USDT" -> "ETHUSDT" */
export function binSymbol(symbol: string): string {
  return symbol.replace("/", "");
}
export function baseAsset(symbol: string): string {
  return symbol.split("/")[0];
}
export function quoteAsset(symbol: string): string {
  return symbol.split("/")[1] ?? "USDT";
}

async function pub(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${path}${q ? `?${q}` : ""}`);
  if (!res.ok) throw new Error(`binance ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function signed(path: string, params: Record<string, string> = {}, method: "GET" | "POST" = "GET"): Promise<unknown> {
  const { key, secret } = creds();
  const q = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: "10000" }).toString();
  const sig = createHmac("sha256", secret).update(q).digest("hex");
  const url = `${BASE}${path}?${q}&signature=${sig}`;
  const res = await fetch(url, { method, headers: { "X-MBX-APIKEY": key } });
  const body = await res.text();
  if (!res.ok) throw new Error(`binance ${path}: HTTP ${res.status} ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : {};
}

export async function getPrice(symbol: string): Promise<number> {
  const r = (await pub("/api/v3/ticker/price", { symbol: binSymbol(symbol) })) as { price: string };
  return Number(r.price);
}

/** free balances by asset (non-zero only) */
export async function getBalances(): Promise<Record<string, number>> {
  const r = (await signed("/api/v3/account")) as { balances: { asset: string; free: string; locked: string }[] };
  const out: Record<string, number> = {};
  for (const b of r.balances) {
    const free = Number(b.free);
    if (free > 0) out[b.asset] = free;
  }
  return out;
}

export interface ApiRestrictions { enableReading: boolean; enableSpotAndMarginTrading: boolean; enableWithdrawals: boolean; ipRestrict: boolean }
export async function getRestrictions(): Promise<ApiRestrictions> {
  return (await signed("/sapi/v1/account/apiRestrictions")) as ApiRestrictions;
}

export async function getFilters(symbol: string): Promise<SymbolFilters> {
  const r = (await pub("/api/v3/exchangeInfo", { symbol: binSymbol(symbol) })) as {
    symbols: { filters: { filterType: string; stepSize?: string; minQty?: string; minNotional?: string }[] }[];
  };
  const f = r.symbols?.[0]?.filters ?? [];
  const lot = f.find((x) => x.filterType === "LOT_SIZE");
  const notional = f.find((x) => x.filterType === "NOTIONAL" || x.filterType === "MIN_NOTIONAL");
  return {
    stepSize: Number(lot?.stepSize ?? 1e-5),
    minQty: Number(lot?.minQty ?? 0),
    minNotional: Number(notional?.minNotional ?? 10),
  };
}

export function roundToStep(qty: number, step: number): number {
  if (step <= 0) return qty;
  return Math.floor(qty / step + 1e-9) * step;
}

/**
 * Market order. BUY spends `quoteOrderQty` USDT (exchange computes qty at market);
 * SELL sells `quantity` base (rounded to LOT_SIZE by the caller). `clientId` makes
 * retries idempotent on the exchange side.
 */
export async function marketOrder(a: {
  symbol: string; side: "BUY" | "SELL"; quantity?: number; quoteOrderQty?: number; clientId?: string;
}): Promise<OrderResult> {
  const params: Record<string, string> = {
    symbol: binSymbol(a.symbol), side: a.side, type: "MARKET",
    newOrderRespType: "FULL",
    ...(a.clientId ? { newClientOrderId: a.clientId.slice(0, 36) } : {}),
  };
  if (a.side === "BUY" && a.quoteOrderQty !== undefined) params.quoteOrderQty = a.quoteOrderQty.toFixed(2);
  else if (a.quantity !== undefined) params.quantity = String(a.quantity);
  else throw new Error("marketOrder: need quantity or quoteOrderQty");
  const r = (await signed("/api/v3/order", params, "POST")) as {
    orderId: number; executedQty: string; cummulativeQuoteQty: string;
    fills?: { price: string; qty: string; commission: string; commissionAsset: string }[];
  };
  const fills: Fill[] = (r.fills ?? []).map((f) => ({ price: Number(f.price), qty: Number(f.qty), commission: Number(f.commission), commissionAsset: f.commissionAsset }));
  const executedQty = Number(r.executedQty);
  const quoteSpent = Number(r.cummulativeQuoteQty);
  return {
    orderId: String(r.orderId),
    executedQty,
    quoteSpent,
    avgPrice: executedQty > 0 ? quoteSpent / executedQty : 0,
    fills,
    raw: r,
  };
}
