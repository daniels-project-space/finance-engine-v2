// BLEND sleeve generation helpers — hash/family/validate for the 70/30 on-chain-
// overlay + BTC-trend blend. Self-contained (a BlendSleeveDoc is not a StrategyDoc).
// This is a HAND-BUILT validated sleeve (Daniel's config), not an evolved family —
// the helpers exist so the seed script can dedupe by hash like the other sleeves.

import { createHash } from "node:crypto";
import type { BlendSleeveDoc } from "./blendsleeve";

export function blendHash(doc: BlendSleeveDoc): string {
  return createHash("sha256")
    .update(JSON.stringify({ k: doc.kind, s: doc.symbol, wa: doc.wOnchain, sma: doc.smaWin, b: doc.nuplBuy, sl: doc.nuplSell, ma: doc.maWin, dca: doc.dcaCapDays }))
    .digest("hex").slice(0, 24);
}

/** Family = symbol + kind (the mechanism), ignoring the exact blend weights. */
export function blendFamilyHash(doc: BlendSleeveDoc): string {
  return createHash("sha256").update(`blend:${doc.symbol}`).digest("hex").slice(0, 24);
}

export function validateBlend(doc: BlendSleeveDoc): string[] {
  const e: string[] = [];
  if (doc.kind !== "blend") e.push("not a blend doc");
  if (!(doc.wOnchain > 0 && doc.wOnchain < 1)) e.push(`wOnchain ${doc.wOnchain} out of (0,1)`);
  if (!(doc.smaWin >= 20 && doc.smaWin <= 400)) e.push(`smaWin ${doc.smaWin} out of range`);
  if (!(doc.maWin >= 50 && doc.maWin <= 400)) e.push(`maWin ${doc.maWin} out of range`);
  if (!doc.risk || !(doc.risk.maxLeverage >= 1)) e.push("missing/invalid risk.maxLeverage");
  return e;
}
