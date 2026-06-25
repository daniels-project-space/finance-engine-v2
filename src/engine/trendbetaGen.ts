// TREND-BETA sleeve generation: long-flat close>SMA(win) risk-managed beta on
// BTC/ETH/SOL. Self-contained validate/hash/family (a TrendBetaDoc is not a
// StrategyDoc). ONE param (smaWin in the monotone grid) to avoid overfit.

import { createHash } from "node:crypto";
import { mulberry32 } from "./stats";
import type { TrendBetaDoc } from "./trendbeta";

const TB_SYMBOLS = ["BTC/USDT", "ETH/USDT", "SOL/USDT"] as const;
const TB_WINS = [100, 150, 200, 250] as const; // monotone SMA grid

export function generateTrendBeta(seed: number): TrendBetaDoc {
  const rng = mulberry32(seed);
  const symbol = TB_SYMBOLS[Math.floor(rng() * TB_SYMBOLS.length)];
  const smaWin = TB_WINS[Math.floor(rng() * TB_WINS.length)];
  return {
    name: `tb_${symbol.split("/")[0].toLowerCase()}_sma${smaWin}_${seed.toString(36)}`,
    kind: "trendbeta",
    hypothesis: `Risk-managed long beta: hold ${symbol} only when price is above its ${smaWin}-day SMA, else sit in cash. Captures the up-trend while sitting out deep bear drawdowns (the trend-filter "safer than buy-and-hold" result). Long-flat, point-in-time SMA.`,
    symbol,
    tf: "1d",
    smaWin,
    params: { smaWin: { min: 80, max: 300, default: smaWin, int: true } },
    risk: { volTargetAnnual: 0.8, maxLeverage: 1 }, // long-flat (no leverage by default)
  };
}

export function validateTrendBeta(doc: TrendBetaDoc): string[] {
  const e: string[] = [];
  if (doc.kind !== "trendbeta") e.push("not a trendbeta doc");
  if (!TB_SYMBOLS.includes(doc.symbol as typeof TB_SYMBOLS[number])) e.push(`symbol ${doc.symbol} not in trend-beta universe`);
  if (!(doc.smaWin >= 50 && doc.smaWin <= 400)) e.push(`smaWin ${doc.smaWin} out of range`);
  if (!doc.risk || !(doc.risk.maxLeverage >= 1)) e.push("missing/invalid risk.maxLeverage");
  return e;
}

export function trendBetaHash(doc: TrendBetaDoc): string {
  return createHash("sha256").update(JSON.stringify({ k: doc.kind, s: doc.symbol, w: doc.smaWin, lev: doc.risk.maxLeverage })).digest("hex").slice(0, 24);
}

/** Family = symbol + kind (the mechanism), ignoring the exact SMA length. */
export function trendBetaFamilyHash(doc: TrendBetaDoc): string {
  return createHash("sha256").update(`trendbeta:${doc.symbol}`).digest("hex").slice(0, 24);
}
