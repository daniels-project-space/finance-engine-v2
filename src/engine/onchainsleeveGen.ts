// ON-CHAIN timing sleeve generation: long-flat BTC/ETH perp timing on the MVRV /
// NVT valuation regime. The A/B winner was MVRV-cheap (long when undervalued).
// Self-contained validate/hash/family. BTC/ETH only (on-chain coverage).

import { createHash } from "node:crypto";
import { mulberry32 } from "./stats";
import type { OcSleeveDoc, OcSignal } from "./onchainsleeve";

const OC_SYMBOLS = ["BTC/USDT", "ETH/USDT"] as const;
const OC_SIGNALS: OcSignal[] = ["mvrv_cheap", "nvt_cheap"]; // the valuation winners (long when cheap)

export function generateOcSleeve(seed: number): OcSleeveDoc {
  const rng = mulberry32(seed);
  const symbol = OC_SYMBOLS[Math.floor(rng() * OC_SYMBOLS.length)];
  const signal = OC_SIGNALS[Math.floor(rng() * OC_SIGNALS.length)];
  const zWin = Math.round(60 + rng() * 200);   // 60-260
  const thresh = Number((rng() * 1.2).toFixed(2)); // 0..1.2
  const metric = signal.startsWith("mvrv") ? "MVRV" : "NVT";
  return {
    name: `oc_${symbol.split("/")[0].toLowerCase()}_${signal.split("_")[0]}_${seed.toString(36)}`,
    kind: "onchainsleeve",
    hypothesis: `On-chain valuation timing (orthogonal to price momentum): long ${symbol} perp only when ${metric} is CHEAP (z-score low) — accumulate when the network is undervalued vs realized cost basis. Point-in-time on-chain (1-day lag). Long-flat.`,
    symbol,
    tf: "1d",
    signal,
    zWin,
    thresh,
    params: {
      zWin: { min: 40, max: 300, default: zWin, int: true },
      thresh: { min: 0, max: 1.5, default: thresh },
    },
    risk: { volTargetAnnual: Number((0.25 + rng() * 0.25).toFixed(2)), maxLeverage: Number((1.5 + rng() * 1.5).toFixed(1)) },
  };
}

export function validateOcSleeve(doc: OcSleeveDoc): string[] {
  const e: string[] = [];
  if (doc.kind !== "onchainsleeve") e.push("not an onchainsleeve doc");
  if (!OC_SYMBOLS.includes(doc.symbol as typeof OC_SYMBOLS[number])) e.push(`symbol ${doc.symbol} has no on-chain coverage (BTC/ETH only)`);
  if (!["mvrv_cheap", "nvt_cheap", "mvrv_rich", "nvt_rich"].includes(doc.signal)) e.push(`bad signal ${doc.signal}`);
  if (!(doc.zWin >= 20 && doc.zWin <= 400)) e.push(`zWin ${doc.zWin} out of range`);
  if (!(doc.thresh >= 0 && doc.thresh <= 2)) e.push(`thresh ${doc.thresh} out of range`);
  if (!doc.risk || !(doc.risk.volTargetAnnual > 0)) e.push("missing risk.volTargetAnnual");
  return e;
}

export function ocSleeveHash(doc: OcSleeveDoc): string {
  return createHash("sha256").update(JSON.stringify({ k: doc.kind, s: doc.symbol, sig: doc.signal, z: doc.zWin, th: doc.thresh })).digest("hex").slice(0, 24);
}

/** Family = symbol + signal (the structural mechanism), ignoring exact thresholds. */
export function ocSleeveFamilyHash(doc: OcSleeveDoc): string {
  return createHash("sha256").update(`oc:${doc.symbol}:${doc.signal}`).digest("hex").slice(0, 24);
}
