// WAVE-3b: RISK-PREMIUM taxonomy + classifier (LIVE-ADDITIVE tagging layer).
//
// A strategy earns money only if it harvests a *risk premium* — a structural
// reason someone on the other side reliably pays. This module names the premium
// FAMILIES the engine can target, ties each to the Wave-3a signals / DSL ops it
// typically uses, and infers (best-effort) which family a given StrategyDoc is
// harvesting from the operators and inputs it actually references.
//
// LIVE-ADDITIVE: classifyPremium() only produces a LABEL. It changes no
// behavior — generateBatch tags each candidate with `premium`, and the gauntlet
// rolls up per-family survive/composite stats so the engine learns which premia
// actually pay. The premium-anchored LLM template (llm.ts) and reading those
// stats back into generation are gated behind a DEFAULT-FALSE config flag.

import type { Expr, StrategyDoc } from "./types";

export type PremiumFamily =
  | "trend_momentum"
  | "carry_funding"
  | "mean_reversion"
  | "basis_term_structure"
  | "vol_risk_premium"
  | "crowding_liquidation"
  | "breakout_expansion"
  | "seasonality"
  | "unclassified";

export interface PremiumSpec {
  family: PremiumFamily;
  /** one-line human description */
  description: string;
  /** WHO is on the other side / WHAT friction creates the premium */
  mechanism: string;
  /** Wave-3a signals / DSL ops a strategy harvesting this premium typically uses */
  signals: string[];
  /** prior expectation: does this premium tend to pay in crypto perps, and the caveat */
  prior: string;
}

// The taxonomy. Ordered most-specific-input → most-generic so the classifier can
// prefer a family whose defining INPUT is present (funding/basis/oi/calendar)
// before falling back to price-structure families (trend/mean-rev/breakout).
export const PREMIUM_TAXONOMY: Record<PremiumFamily, PremiumSpec> = {
  carry_funding: {
    family: "carry_funding",
    description: "Harvest the perpetual funding rate: get paid to hold the unpopular side.",
    mechanism:
      "Perp longs pay shorts (or vice-versa) via funding when positioning is one-sided. Leveraged trend-chasers and structural longs pay a recurring carry to the patient counterparty who fades the crowd.",
    signals: ["funding", "fundmom", "fundroc", "fundzscore", "fundaccel"],
    prior:
      "Reliable and economically grounded in crypto perps (funding is an explicit cash flow). Edge concentrates at funding extremes; raw carry is small per bar and demands low turnover.",
  },
  basis_term_structure: {
    family: "basis_term_structure",
    description: "Trade the perp-spot basis: a term-structure / convergence premium.",
    mechanism:
      "The perp trades rich or cheap to spot when leverage demand dislocates the basis. Basis must converge as funding re-prices it, so a stretched basis is a mean-reverting carry/term-structure signal.",
    signals: ["basis", "basis_zscore_96", "basis_roc_24"],
    prior:
      "Grounded (basis convergence is mechanical) but noisy and data-dependent; works best as a normalized z-score, not raw level. Distinct from funding: it prices the dislocation, funding pays it off.",
  },
  crowding_liquidation: {
    family: "crowding_liquidation",
    description: "Fade crowded positioning / front-run forced de-leveraging.",
    mechanism:
      "When open interest and the long/short ratio reach extremes, marginal leveraged positions are fragile. Liquidation cascades transfer wealth from the over-positioned crowd to whoever is positioned against the unwind.",
    signals: ["oi", "oi_zscore_168", "oi_roc_24", "lsr", "lsr_zscore_96", "fundzscore"],
    prior:
      "Real and crypto-specific (forced liquidations are observable). Timing is hard — crowding can persist; pairs best with a trigger, not a standalone fade.",
  },
  seasonality: {
    family: "seasonality",
    description: "Calendar effects: hour-of-day / day-of-week flow patterns.",
    mechanism:
      "Recurring liquidity and flow cycles (US session, weekend thin books) create predictable, non-price drift. The premium is for providing liquidity when scheduled participants are absent.",
    signals: ["hourutc", "dowutc"],
    prior:
      "Documented in crypto (intraday + weekend anomalies) but small and decay-prone; pure calendar edges need tight risk and survive only if structural, not data-mined.",
  },
  vol_risk_premium: {
    family: "vol_risk_premium",
    description: "Volatility risk premium / vol-regime conditioning.",
    mechanism:
      "Realized vol mean-reverts and is over/under-priced relative to demand for protection. Conditioning exposure on the vol regime (sizing up in calm, down in chaos) harvests the gap between implied fear and realized outcome.",
    signals: ["atr_ratio_14", "stdev_pctrank_30", "atr", "stdev"],
    prior:
      "Robust as a CONDITIONING overlay (vol-targeting, regime gates). As a standalone directional edge it is weak — treat it as a risk lens more than an alpha.",
  },
  breakout_expansion: {
    family: "breakout_expansion",
    description: "Range breakout with volatility expansion (continuation).",
    mechanism:
      "A break of a prior high/low on expanding range resolves coiled positioning. Stops and momentum entries above the level feed continuation — the premium is for bearing the gap/whipsaw risk that scares discretionary traders out.",
    signals: ["highest", "lowest", "stdev", "atr", "roc_24"],
    prior:
      "Classic managed-futures workhorse; generalizes across assets. Whipsaw-prone without a regime filter; needs a trailing stop to bank the fat tail.",
  },
  mean_reversion: {
    family: "mean_reversion",
    description: "Short-horizon mean reversion: fade over-extension to the mean.",
    mechanism:
      "Liquidity-driven overshoots (forced flow, panic) push price off its short-term mean. Providing liquidity into the overshoot earns the reversion when depth returns — you are paid for inventory risk.",
    signals: ["zscore_close_96", "rsi_14", "pctrank"],
    prior:
      "Persistent at short horizons but regime-fragile: deadly in a trending breakdown. Demands a long-side regime filter and disciplined stops.",
  },
  trend_momentum: {
    family: "trend_momentum",
    description: "Time-series momentum / trend following.",
    mechanism:
      "Under-reaction and slow information diffusion let trends persist; risk-management herding (stops, trend-chasing) extends them. The premium compensates the trend follower for sitting through whipsaws and the rare sharp reversal.",
    signals: ["roc_24", "roc_96", "slope_48", "ema", "sma"],
    prior:
      "The most robust, most-documented premium across assets and decades. Low hit-rate, fat right tail; survives OOS when slow and few-param.",
  },
  unclassified: {
    family: "unclassified",
    description: "No dominant premium could be inferred from the structure.",
    mechanism: "(none inferred)",
    signals: [],
    prior: "Ambiguous mix or too little structure to attribute — treat as exploratory.",
  },
};

export const PREMIUM_FAMILIES: PremiumFamily[] = (Object.keys(PREMIUM_TAXONOMY) as PremiumFamily[])
  .filter((f) => f !== "unclassified");

// --------------------------------------------------------------- classifier
// We score each family by walking the candidate's four expression trees and
// counting evidence: crypto-native / calendar LEAF inputs (strong, family-
// defining), plus price-structure OPERATOR patterns (trend smoothers, reversion
// normalizers, breakout extremes, vol features). The highest-scoring family wins;
// leaf-defined families outweigh structure-only ones so a funding-zscore fade is
// carry_funding even though it also contains a comparison.

interface Tally {
  // family-defining leaf inputs
  funding: number; basis: number; oi: number; lsr: number; calendar: number;
  // price-structure operator evidence
  trend: number; reversion: number; breakout: number; vol: number;
  hasShorts: boolean;
}

function emptyTally(): Tally {
  return { funding: 0, basis: 0, oi: 0, lsr: 0, calendar: 0, trend: 0, reversion: 0, breakout: 0, vol: 0, hasShorts: false };
}

function walk(e: Expr | undefined, t: Tally): void {
  if (!e || typeof e !== "object") return;
  const n = e as Record<string, unknown> & { op: string };
  switch (n.op) {
    // ---- family-defining leaf inputs (Wave-3a + calendar) ----
    case "funding": case "fundroc": case "fundzscore": case "fundaccel": case "fundmom":
      t.funding++; break;
    case "basis": t.basis++; break;
    case "oi": t.oi++; break;
    case "lsr": t.lsr++; break;
    case "hourutc": case "dowutc": t.calendar++; break;
    // ---- price-structure operators ----
    case "ema": case "sma": case "wma": case "slope": case "roc":
      t.trend++; break;
    case "rsi": t.reversion++; break;
    case "zscore": case "pctrank":
      // normalizers read as reversion UNLESS wrapped on a crypto leaf (handled by
      // the leaf counters above, which the children-walk also increments).
      t.reversion++; break;
    case "highest": case "lowest":
      t.breakout++; break;
    case "atr": case "stdev":
      t.vol++; break;
    default: break;
  }
  for (const k of ["src", "period", "a", "b"]) walk(n[k] as Expr | undefined, t);
}

export interface PremiumClassification {
  premium: PremiumFamily;
  /** all non-zero family scores, descending — for transparency / dashboards */
  scores: { family: PremiumFamily; score: number }[];
}

/**
 * Infer the risk-premium family a strategy is harvesting from the signals and
 * structure it references. Best-effort: returns the dominant family plus the
 * full score vector. Leaf-defined (crypto-native / calendar) families dominate
 * price-structure families when present, because the input itself names the
 * premium. Ties break by the taxonomy order (most specific first).
 */
export function classifyPremium(doc: StrategyDoc): PremiumClassification {
  const t = emptyTally();
  walk(doc.longEntry, t);
  walk(doc.longExit, t);
  walk(doc.shortEntry, t);
  walk(doc.shortExit, t);
  t.hasShorts = !!doc.shortEntry;

  // Leaf-defined families carry a high base weight (3 per reference) so any
  // genuine crypto-native / calendar input outranks incidental price structure.
  // A leaf family gets a flat PRESENCE bonus (so a single crypto/calendar input
  // clears any amount of incidental price structure — the input itself names the
  // premium) PLUS a per-reference weight (to break ties BETWEEN leaf families).
  const LEAF_W = 3;
  const PRESENCE = 5; // > the largest plausible price-structure score, so any leaf wins
  const leaf = (n: number, extra = 0) => (n > 0 || extra > 0 ? PRESENCE + LEAF_W * n + extra : 0);
  const raw: Record<PremiumFamily, number> = {
    carry_funding: leaf(t.funding),
    basis_term_structure: leaf(t.basis),
    // OI + LSR are the crowding inputs; funding-zscore extremity also contributes
    // (it is the crowding gauge), but at a lighter weight so a pure funding-carry
    // strategy stays carry_funding.
    crowding_liquidation: leaf(t.oi + t.lsr, 1 * t.funding),
    seasonality: leaf(t.calendar),
    // price-structure families: weight 1 per operator hit (no presence bonus).
    vol_risk_premium: t.vol,
    breakout_expansion: 2 * t.breakout,
    mean_reversion: t.reversion,
    trend_momentum: t.trend,
    unclassified: 0,
  };

  // If a crypto-native carry strategy ALSO trends on price (e.g. funding gate +
  // MA cross), the funding leaf still defines the premium; structure is secondary.
  const scored = (Object.keys(raw) as PremiumFamily[])
    .filter((f) => f !== "unclassified" && raw[f] > 0)
    .map((f) => ({ family: f, score: raw[f] }));

  if (scored.length === 0) {
    return { premium: "unclassified", scores: [] };
  }

  // Stable order: score desc, then taxonomy order (PREMIUM_FAMILIES is ordered
  // most-specific input first).
  const order = new Map(PREMIUM_FAMILIES.map((f, i) => [f, i]));
  scored.sort((a, b) => b.score - a.score || (order.get(a.family)! - order.get(b.family)!));

  return { premium: scored[0].family, scores: scored };
}

/** Convenience: just the family label (what generateBatch persists). */
export function premiumOf(doc: StrategyDoc): PremiumFamily {
  return classifyPremium(doc).premium;
}

/** Compact taxonomy text for prompt injection (family + mechanism + signals). */
export function premiumCatalogText(): string {
  return PREMIUM_FAMILIES.map((f) => {
    const s = PREMIUM_TAXONOMY[f];
    return `- ${f}: ${s.description}\n    mechanism: ${s.mechanism}\n    typical signals: ${s.signals.join(", ")}\n    prior: ${s.prior}`;
  }).join("\n");
}
