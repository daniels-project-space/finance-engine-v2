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
export type XSectionFlavor = "trend" | "trend_composite" | "carry_funding" | "basis_disloc" | "oi_washout" | "lsr_contrarian" | "liquidity" | "size";

export function generateXSection(seed: number, flavor: XSectionFlavor): XSectionDoc {
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
  } else if (flavor === "carry_funding") {
    // PURE FUNDING CARRY — NO trend term. Rank coins by how favorable funding is to
    // a long-flat holder: a long RECEIVES funding when funding is NEGATIVE (crowded
    // shorts pay longs). Rank HIGH when the funding z-score is most negative.
    // zscore over a window normalizes cross-coin funding scale. Pure microstructure.
    const win = declare("fwin", 24, 240, 96);
    rankSignal = { op: "neg", a: { op: "zscore", src: { op: "funding" }, period: win } };
    hypothesis = "PURE cross-sectional funding carry (no trend): long the coins whose perp funding is most NEGATIVE (z-scored) — crowded shorts pay you to hold long there. Harvests the funding-premium directly; economically orthogonal to price momentum. Long top-K, long-flat.";
    mechanism = "xs_carry_funding";
  } else if (flavor === "basis_disloc") {
    // PURE BASIS MEAN-REVERSION — NO trend term. Rank by perp-spot basis; long the
    // coins trading at the biggest DISCOUNT (most negative basis), expecting
    // convergence back to fair. z-score the basis for cross-coin comparability.
    const win = declare("bwin", 24, 240, 96);
    rankSignal = { op: "neg", a: { op: "zscore", src: { op: "basis" }, period: win } };
    hypothesis = "PURE cross-sectional basis dislocation (no trend): long the coins whose perp trades cheapest vs spot (most negative basis, z-scored), expecting basis convergence. A carry/mean-reversion premium distinct from momentum. Long top-K, long-flat.";
    mechanism = "xs_basis";
  } else if (flavor === "oi_washout") {
    // PURE POSITIONING WASHOUT — NO trend term. Rank by OI change: long the coins
    // with the largest OI CONTRACTION (positioning flushed out / de-crowded),
    // expecting a rebound from washed-out leverage. roc(oi) negative = washout.
    const win = declare("owin", 12, 120, 48);
    rankSignal = { op: "neg", a: { op: "zscore", src: { op: "roc", src: { op: "oi" }, period: win }, period: { op: "const", value: 96 } } };
    hypothesis = "PURE cross-sectional positioning washout (no trend): long the coins whose open interest contracted most (leverage flushed / de-crowded), expecting a rebound from cleaned-out positioning. Distinct from price trend. Long top-K, long-flat.";
    mechanism = "xs_oi";
  } else if (flavor === "lsr_contrarian") {
    // PURE LSR CONTRARIAN — NO trend term. Rank by taker long/short ratio; long the
    // coins where the crowd is LEAST long (lowest LSR z-score = washed-out / fearful),
    // a contrarian positioning premium. Pure microstructure.
    const win = declare("lwin", 24, 240, 96);
    rankSignal = { op: "neg", a: { op: "zscore", src: { op: "lsr" }, period: win } };
    hypothesis = "PURE cross-sectional positioning contrarian (no trend): long the coins where the taker long/short ratio is most depressed (crowd least long / capitulated), a contrarian rebound premium. Orthogonal to momentum. Long top-K, long-flat.";
    mechanism = "xs_lsr";
  } else if (flavor === "liquidity") {
    // LIQUIDITY FACTOR — NO trend term. Rank by trailing dollar volume (close*volume,
    // smoothed = ADV proxy). The liquidity premium says LESS-liquid assets carry
    // higher expected returns (illiquidity compensation), so we rank HIGH when ADV is
    // LOW (long the smaller/less-liquid tier). Pure characteristic, not price trend.
    const win = declare("lqwin", 20, 160, 60);
    const dollarVol: Expr = { op: "mul", a: { op: "price", field: "close" }, b: { op: "price", field: "volume" } };
    const adv: Expr = { op: "sma", src: dollarVol, period: win };
    rankSignal = { op: "neg", a: { op: "zscore", src: adv, period: { op: "const", value: 100 } } };
    hypothesis = "Cross-sectional liquidity factor (no trend): long the LESS-liquid tier (lowest trailing dollar-volume / ADV, z-scored) to harvest the illiquidity premium — smaller/less-traded coins compensate holders with higher expected return. A priced characteristic distinct from momentum. Long top-K, long-flat.";
    mechanism = "xs_liquidity";
  } else {
    // SIZE FACTOR — NO trend term. No market-cap feed, so use trailing dollar volume
    // as a SIZE proxy (research: volume-as-proxy when cap unavailable). The size/small-
    // cap premium says SMALLER assets carry higher expected returns, so rank HIGH when
    // the size proxy is LOW (long the smaller tier). Long-biased characteristic.
    const win = declare("szwin", 40, 240, 120);
    const dollarVol: Expr = { op: "mul", a: { op: "price", field: "close" }, b: { op: "price", field: "volume" } };
    const sizeProxy: Expr = { op: "sma", src: dollarVol, period: win }; // long-window avg $vol ~ size
    rankSignal = { op: "neg", a: { op: "zscore", src: sizeProxy, period: { op: "const", value: 150 } } };
    hypothesis = "Cross-sectional size factor (no trend): long the SMALLER tier (lowest long-window dollar-volume proxy for market cap, z-scored) to harvest the small-cap premium. A priced characteristic, long-biased, distinct from momentum. Long top-K, long-flat.";
    mechanism = "xs_size";
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
