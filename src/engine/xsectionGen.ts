// CROSS-SECTIONAL generation lane. Proposes long-flat cross-sectional sleeves
// that rank the universe by a per-coin `rankSignal` and go long the top-K.
// Covers TREND (trailing-return / CTREND-style composite) and funding-CARRY rank.
// REVERSAL is intentionally NOT generated — the Step-3 spike proved it dead (-0.62).
//
// Hashing/validation are self-contained (xsection docs are not StrategyDocs).

import { createHash } from "node:crypto";
import { mulberry32 } from "./stats";
import type { Expr, ParamSpec } from "./types";
import type { XSectionDoc } from "./xsection";

function p(name: string, min: number, max: number, def: number, int = true): { spec: ParamSpec; ref: Expr } {
  return { spec: { min, max, default: def, int }, ref: { op: "param", name } };
}

/** A trailing return over `lookback` bars, computed causally (roc of close). */
function trailingReturn(lookbackRef: Expr): Expr {
  return { op: "roc", src: { op: "price", field: "close" }, period: lookbackRef };
}

/**
 * Generate ONE cross-sectional sleeve. `flavor`:
 *  - "trend": rank by a vol-normalized trailing return (CTREND-style: roc / atr).
 *  - "trend_composite": blend of two horizons (fast+slow roc) — momentum composite.
 *  - "carry": rank by funding carry (negative funding = you GET PAID to be long;
 *    rank ascending so the LEAST-crowded / paid-to-hold coins rank highest). We
 *    encode "rank high when funding is low" as neg(fundmom).
 *  - "carry_trend": funding-screened trend (trend rank gated by low funding).
 * All LONG-FLAT. tf defaults to 4h (sane turnover).
 */
export function generateXSection(seed: number, flavor: "trend" | "trend_composite" | "carry" | "carry_trend"): XSectionDoc {
  const rng = mulberry32(seed);
  const params: Record<string, ParamSpec> = {};
  const declare = (name: string, min: number, max: number, def: number, int = true): Expr => {
    const { spec, ref } = p(name, min, max, def, int); params[name] = spec; return ref;
  };
  const tf = rng() < 0.7 ? "4h" : "1d";
  const lookback = Math.round(30 + rng() * 90); // 30-120 bars
  const topK = Math.round(4 + rng() * 5);       // 4-9 longs
  const rebalEvery = Math.round(2 + rng() * 10);

  let rankSignal: Expr;
  let hypothesis: string;
  let mechanism: string;
  if (flavor === "trend") {
    const lb = declare("lb", 20, 160, lookback);
    // vol-normalized momentum: roc(close, lb) / atr-ratio  (CTREND-style)
    rankSignal = {
      op: "div",
      a: trailingReturn(lb),
      b: { op: "max2", a: { op: "div", a: { op: "atr", src: { op: "price", field: "close" }, period: { op: "const", value: 20 } }, b: { op: "sma", src: { op: "price", field: "close" }, period: { op: "const", value: 20 } } }, b: { op: "const", value: 1e-6 } },
    };
    hypothesis = "Cross-sectional momentum: coins with the strongest vol-normalized trailing return continue to outperform the cross-section (slow allocator rebalancing + retail trend-chasing). Long the top-K, equal-weight, long-flat.";
    mechanism = "xs_trend";
  } else if (flavor === "trend_composite") {
    const lbF = declare("lbFast", 10, 60, Math.round(lookback / 3));
    const lbS = declare("lbSlow", 60, 200, lookback + 40);
    rankSignal = { op: "add", a: trailingReturn(lbF), b: trailingReturn(lbS) };
    hypothesis = "Cross-sectional momentum composite (fast+slow horizon blend): coins persistently strong across horizons lead the cross-section. Long top-K, long-flat.";
    mechanism = "xs_trend";
  } else if (flavor === "carry") {
    // rank HIGH when cumulative funding is LOW/negative (you are paid to hold long)
    rankSignal = { op: "neg", a: { op: "fundmom" } };
    hypothesis = "Cross-sectional carry: long the coins with the LEAST positive (or negative) funding — longs there are paid by crowded shorts rather than paying crowded longs. Harvests the funding carry premium cross-sectionally. Long top-K, long-flat.";
    mechanism = "xs_carry";
  } else {
    // carry_trend: trend rank, screened to coins not paying heavy funding
    const lb = declare("lb", 20, 160, lookback);
    rankSignal = { op: "sub", a: trailingReturn(lb), b: { op: "mul", a: { op: "const", value: 5 }, b: { op: "max2", a: { op: "fundmom" }, b: { op: "const", value: 0 } } } };
    hypothesis = "Cross-sectional trend, funding-screened: rank by trailing return but penalize coins with high positive funding (crowded longs that bleed carry). Combines momentum + carry cross-sectionally. Long top-K, long-flat.";
    mechanism = "xs_carry";
  }

  const doc: XSectionDoc = {
    name: `xs_${flavor.split("_")[0]}_${seed.toString(36)}`,
    kind: "xsection",
    hypothesis,
    tf,
    rankSignal,
    lookback: Math.max(lookback, 20),
    topK,
    rebalEvery,
    side: "long-flat",
    params,
    risk: { volTargetAnnual: Number((0.3 + rng() * 0.3).toFixed(2)), maxLeverage: Number((2 + rng() * 1.5).toFixed(1)) },
  };
  (doc as XSectionDoc & { mechanism?: string }).mechanism = mechanism;
  return doc;
}

/** Validate a cross-sectional doc (long-flat guard + sane bounds). */
export function validateXSection(doc: XSectionDoc): string[] {
  const errs: string[] = [];
  if (doc.kind !== "xsection") errs.push("not an xsection doc");
  if (doc.side !== "long-flat") errs.push("xsection must be long-flat (no shorting)");
  if (!doc.rankSignal) errs.push("missing rankSignal");
  if (!(doc.topK >= 1 && doc.topK <= 20)) errs.push(`topK ${doc.topK} out of [1,20]`);
  if (!(doc.rebalEvery >= 1 && doc.rebalEvery <= 60)) errs.push(`rebalEvery ${doc.rebalEvery} out of [1,60]`);
  if (!(doc.lookback >= 5 && doc.lookback <= 400)) errs.push(`lookback ${doc.lookback} out of [5,400]`);
  if (!doc.risk || !(doc.risk.volTargetAnnual > 0)) errs.push("missing risk.volTargetAnnual");
  return errs;
}

/** Exact content hash (dedup) over the canonical doc shape. */
export function xsectionHash(doc: XSectionDoc): string {
  const canon = JSON.stringify({ k: doc.kind, r: doc.rankSignal, tf: doc.tf, topK: doc.topK, rebal: doc.rebalEvery, lb: doc.lookback });
  return createHash("sha256").update(canon).digest("hex").slice(0, 24);
}

/** Family hash — same structural rank mechanism, ignoring exact lookback/topK. */
export function xsectionFamilyHash(doc: XSectionDoc): string {
  const skeleton = JSON.stringify(stripConsts(doc.rankSignal));
  return createHash("sha256").update("xs:" + skeleton).digest("hex").slice(0, 24);
}
function stripConsts(e: Expr): unknown {
  const n = e as unknown as Record<string, unknown>;
  if (n.op === "const" || n.op === "param") return { op: n.op };
  const out: Record<string, unknown> = { op: n.op };
  for (const k of ["src", "a", "b", "period"]) if (n[k]) out[k] = stripConsts(n[k] as Expr);
  if (typeof n.field === "string") out.field = n.field;
  return out;
}
