// IV-TIMING sleeve generation: produces long-flat BTC/ETH perp-timing sleeves
// driven by the DVOL implied-vol regime / IV-RV spread. Self-contained
// validate/hash/family (an IvSleeveDoc is not a StrategyDoc). DVOL only exists for
// BTC & ETH, so the universe of this family is exactly {BTC/USDT, ETH/USDT}.

import { createHash } from "node:crypto";
import { mulberry32 } from "./stats";
import type { IvSleeveDoc, IvSignal } from "./ivsleeve";

const IV_SYMBOLS = ["BTC/USDT", "ETH/USDT"] as const;
const IV_SIGNALS: IvSignal[] = ["dvol_high", "ivrv_high"]; // the spike's winners; long in high-vol/rich-premium

export function generateIvSleeve(seed: number): IvSleeveDoc {
  const rng = mulberry32(seed);
  const symbol = IV_SYMBOLS[Math.floor(rng() * IV_SYMBOLS.length)];
  const signal = IV_SIGNALS[Math.floor(rng() * IV_SIGNALS.length)];
  const zWin = Math.round(60 + rng() * 200);   // 60-260
  const thresh = Number((rng() * 1.2).toFixed(2)); // 0..1.2
  const rvWin = Math.round(15 + rng() * 25);   // 15-40d realized-vol window
  const sigName = signal === "dvol_high" ? "high-vol regime" : "rich vol-premium (IV>RV)";
  return {
    name: `iv_${symbol.split("/")[0].toLowerCase()}_${signal.split("_")[0]}_${seed.toString(36)}`,
    kind: "ivsleeve",
    hypothesis: `Options-IV timing (orthogonal to price momentum): long ${symbol} perp only in a ${sigName}, using the Deribit DVOL implied-vol index (point-in-time). Harvests the vol-regime/vol-risk-premium signal directionally on the perp. Long-flat.`,
    symbol,
    tf: "1d",
    signal,
    zWin,
    thresh,
    rvWin,
    params: {
      zWin: { min: 40, max: 300, default: zWin, int: true },
      thresh: { min: 0, max: 1.5, default: thresh },
    },
    risk: { volTargetAnnual: Number((0.25 + rng() * 0.25).toFixed(2)), maxLeverage: Number((1.5 + rng() * 1.5).toFixed(1)) },
  };
}

export function validateIvSleeve(doc: IvSleeveDoc): string[] {
  const e: string[] = [];
  if (doc.kind !== "ivsleeve") e.push("not an ivsleeve doc");
  if (!IV_SYMBOLS.includes(doc.symbol as typeof IV_SYMBOLS[number])) e.push(`symbol ${doc.symbol} has no DVOL (BTC/ETH only)`);
  if (!["dvol_high", "ivrv_high", "dvol_low", "ivrv_low"].includes(doc.signal)) e.push(`bad signal ${doc.signal}`);
  if (!(doc.zWin >= 20 && doc.zWin <= 400)) e.push(`zWin ${doc.zWin} out of range`);
  if (!(doc.thresh >= 0 && doc.thresh <= 2)) e.push(`thresh ${doc.thresh} out of range`);
  if (!doc.risk || !(doc.risk.volTargetAnnual > 0)) e.push("missing risk.volTargetAnnual");
  return e;
}

export function ivSleeveHash(doc: IvSleeveDoc): string {
  return createHash("sha256").update(JSON.stringify({ k: doc.kind, s: doc.symbol, sig: doc.signal, z: doc.zWin, th: doc.thresh, rv: doc.rvWin })).digest("hex").slice(0, 24);
}

/** Family = symbol + signal (the structural mechanism), ignoring exact thresholds. */
export function ivSleeveFamilyHash(doc: IvSleeveDoc): string {
  return createHash("sha256").update(`iv:${doc.symbol}:${doc.signal}`).digest("hex").slice(0, 24);
}
