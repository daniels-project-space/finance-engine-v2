// Genetic programming over DSL expression trees.
// This is where novel indicators come from: composition of mathematical
// primitives (zscore-of-slope, pctrank-of-ATR-ratio, ...) searched at scale,
// then forced through the gauntlet. Deterministic given a seed.

import { mulberry32 } from "./stats";
import { validateStrategy } from "./dsl";
import { instantiateMechanism, combineMechanisms, MECHANISMS } from "./mechanisms";
import type { Expr, ParamSpec, PriceField, StrategyDoc } from "./types";

type Rng = () => number;

const FIELDS: PriceField[] = ["open", "high", "low", "close", "volume"];
const SMOOTHERS = ["ema", "sma", "wma"] as const;
const NORMALIZERS = ["zscore", "pctrank", "rsi"] as const;

// ---- CALIBRATION PASS: IC-steered generation (config-gated, cold-start safe) --
// generateBatch reads the persisted signal-IC report and calls setIcBias() with a
// per-crypto-leaf-family weight derived from the ranking (basis / funding / oi /
// lsr). The GP grammar sampler then PREFERS high-IC crypto-native inputs instead
// of choosing uniformly. With no report (cold start) the bias is null => the old
// uniform behavior is preserved exactly. Deterministic given a seed.
export type CryptoLeafFamily = "funding" | "basis" | "oi" | "lsr";
let IC_BIAS: Record<CryptoLeafFamily, number> | null = null;
/** Set (or clear) the IC-derived per-family weight for crypto-native feature
 *  selection. Pass null to restore uniform sampling. */
export function setIcBias(weights: Record<CryptoLeafFamily, number> | null): void { IC_BIAS = weights; }
export function getIcBias(): Record<CryptoLeafFamily, number> | null { return IC_BIAS; }

/** Weighted pick over the 4 crypto-leaf families using the IC bias; uniform when
 *  no bias is set. Returns the chosen family. */
function pickCryptoFamily(rng: Rng): CryptoLeafFamily {
  const fams: CryptoLeafFamily[] = ["funding", "basis", "oi", "lsr"];
  if (!IC_BIAS) return pick(rng, fams);
  const w = fams.map((f) => Math.max(1e-3, IC_BIAS![f] ?? 1e-3));
  const sum = w.reduce((a, b) => a + b, 0);
  let r = rng() * sum;
  for (let i = 0; i < fams.length; i++) { r -= w[i]; if (r <= 0) return fams[i]; }
  return fams[fams.length - 1];
}

let nameCounter = 0;
function freshParam(params: Record<string, ParamSpec>, min: number, max: number, def: number, int = true): Expr {
  const name = `p${Object.keys(params).length}_${nameCounter++ % 1000}`;
  params[name] = { min, max, default: def, int };
  return { op: "param", name };
}

function pick<T>(rng: Rng, arr: readonly T[]): T { return arr[Math.floor(rng() * arr.length)]; }
function randInt(rng: Rng, lo: number, hi: number): number { return lo + Math.floor(rng() * (hi - lo + 1)); }

// ---------- numeric feature generators (the indicator grammar) ----------
function genFeature(rng: Rng, params: Record<string, ParamSpec>, depth: number): Expr {
  const close: Expr = { op: "price", field: "close" };
  const choice = rng();
  if (depth > 2 || choice < 0.2) {
    // smoothed price
    return { op: pick(rng, SMOOTHERS), src: close, period: freshParam(params, 5, 100, randInt(rng, 10, 50)) };
  }
  if (choice < 0.35) {
    // normalized momentum: zscore/pctrank of ROC
    const mom: Expr = { op: "roc", src: close, period: freshParam(params, 2, 60, randInt(rng, 5, 30)) };
    return { op: pick(rng, ["zscore", "pctrank"] as const), src: mom, period: freshParam(params, 20, 200, randInt(rng, 50, 100)) };
  }
  if (choice < 0.5) {
    // volatility feature: ATR ratio or stdev pctrank
    if (rng() < 0.5) {
      const a: Expr = { op: "atr", src: close, period: freshParam(params, 5, 50, 14) };
      return { op: "div", a, b: { op: pick(rng, SMOOTHERS), src: close, period: { op: "const", value: 20 } } };
    }
    return { op: "pctrank", src: { op: "stdev", src: close, period: freshParam(params, 10, 100, 30) }, period: { op: "const", value: 100 } };
  }
  if (choice < 0.65) {
    // trend strength: normalized regression slope
    return { op: "slope", src: close, period: freshParam(params, 10, 120, randInt(rng, 20, 60)) };
  }
  if (choice < 0.8) {
    // channel position: (close - lowest) / (highest - lowest) — Stoch-like, composed
    const n = freshParam(params, 10, 150, randInt(rng, 20, 80));
    const hi: Expr = { op: "highest", src: { op: "price", field: "high" }, period: n };
    const lo: Expr = { op: "lowest", src: { op: "price", field: "low" }, period: n };
    return { op: "div", a: { op: "sub", a: close, b: lo }, b: { op: "max2", a: { op: "sub", a: hi, b: lo }, b: { op: "const", value: 1e-9 } } };
  }
  if (choice < 0.85) {
    // volume-confirmed flow: zscore of volume
    return { op: "zscore", src: { op: "price", field: "volume" }, period: freshParam(params, 20, 200, 50) };
  }
  if (choice < 0.92) {
    // WAVE-3a crypto-native feature: a normalized read of funding dynamics /
    // basis / OI / positioning. These are pre-derived per bar (funding-roc/z/accel/
    // mom) or raw last-known (basis/oi/lsr); normalize raw ones for scale-freedom.
    return genCryptoFeature(rng, params);
  }
  // composed: feature-of-feature (the novel-indicator path)
  const inner = genFeature(rng, params, depth + 1);
  return { op: pick(rng, NORMALIZERS), src: inner, period: freshParam(params, 14, 150, randInt(rng, 20, 60)) };
}

// WAVE-3a: crypto-native numeric features. Funding-dynamics inputs are already
// derived (roc/zscore/accel/mom), so they can be used directly or lightly
// normalized; basis/oi/lsr are raw series, normalized for scale-freedom.
function genCryptoFeature(rng: Rng, params: Record<string, ParamSpec>): Expr {
  // CALIBRATION PASS: the leaf FAMILY is chosen IC-weighted (uniform if no bias);
  // the within-family expression detail is rolled exactly as before.
  const family = pickCryptoFamily(rng);
  if (family === "funding") {
    const c = rng();
    if (c < 0.4) return { op: "fundzscore" };                     // funding crowding extremity (already z)
    if (c < 0.65) return { op: "fundroc" };                       // funding momentum (Δf)
    if (c < 0.82) return { op: "fundaccel" };                     // funding acceleration
    return { op: "fundmom" };                                     // cumulative carry pressure
  }
  if (family === "basis") {
    // basis dynamics: zscore/roc of perp-spot basis (carry mean-reversion)
    const raw: Expr = { op: "basis" };
    return rng() < 0.5
      ? { op: "zscore", src: raw, period: freshParam(params, 24, 240, randInt(rng, 48, 120)) }
      : { op: "roc", src: raw, period: freshParam(params, 6, 96, randInt(rng, 12, 48)) };
  }
  if (family === "oi") {
    // open-interest dynamics: zscore or roc of OI (positioning build/flush)
    const raw: Expr = { op: "oi" };
    return rng() < 0.5
      ? { op: "zscore", src: raw, period: freshParam(params, 24, 300, randInt(rng, 48, 168)) }
      : { op: "roc", src: raw, period: freshParam(params, 6, 96, randInt(rng, 12, 48)) };
  }
  // taker long/short positioning, normalized
  return { op: "zscore", src: { op: "lsr" }, period: freshParam(params, 24, 240, randInt(rng, 48, 120)) };
}

// ---------- boolean trigger generators ----------
function genTrigger(rng: Rng, params: Record<string, ParamSpec>): Expr {
  const close: Expr = { op: "price", field: "close" };
  const kind = rng();
  if (kind < 0.12) {
    // funding/carry trigger: act against crowded positioning. WAVE-3a: sometimes
    // trigger on funding DYNAMICS (z-score extremity / acceleration) or basis,
    // which lead spot funding extremes.
    const flavor = rng();
    if (flavor < 0.35) {
      // funding z-score crowding extreme (already normalized — threshold in sd units)
      const z = freshParam(params, 1, 3, 2, false);
      return rng() < 0.5
        ? { op: "lt", a: { op: "fundzscore" }, b: { op: "neg", a: z } }
        : { op: "gt", a: { op: "fundzscore" }, b: z };
    }
    if (flavor < 0.55) {
      // basis dislocation: enter when perp trades rich/cheap vs spot
      const bth = freshParam(params, 0.0005, 0.01, 0.002, false);
      return rng() < 0.5
        ? { op: "gt", a: { op: "basis" }, b: bth }
        : { op: "lt", a: { op: "basis" }, b: { op: "neg", a: bth } };
    }
    const th = freshParam(params, 0.0001, 0.001, 0.0003, false);
    return rng() < 0.5
      ? { op: "lt", a: { op: "funding" }, b: { op: "neg", a: th } }
      : { op: "gt", a: { op: "funding" }, b: th };
  }
  if (kind < 0.3) {
    // MA cross
    const fast: Expr = { op: pick(rng, SMOOTHERS), src: close, period: freshParam(params, 3, 40, randInt(rng, 5, 20)) };
    const slow: Expr = { op: pick(rng, SMOOTHERS), src: close, period: freshParam(params, 30, 300, randInt(rng, 50, 150)) };
    return { op: "crossover", a: fast, b: slow };
  }
  if (kind < 0.55) {
    // breakout: close > highest(high, n) lagged 1
    const n = freshParam(params, 10, 200, randInt(rng, 20, 100));
    const hh: Expr = { op: "lag", src: { op: "highest", src: { op: "price", field: "high" }, period: n }, period: { op: "const", value: 1 } };
    return { op: "gt", a: close, b: hh };
  }
  if (kind < 0.8) {
    // threshold on a generated feature
    const f = genFeature(rng, params, 0);
    const th = freshParam(params, -2, 2, Number((rng() * 2 - 0.5).toFixed(2)), false);
    return rng() < 0.5 ? { op: "gt", a: f, b: th } : { op: "lt", a: f, b: th };
  }
  // mean reversion: zscore < -k
  const z: Expr = { op: "zscore", src: close, period: freshParam(params, 20, 120, 50) };
  const k = freshParam(params, 0.5, 3, 1.5, false);
  return { op: "lt", a: z, b: { op: "neg", a: k } };
}

function genFilter(rng: Rng, params: Record<string, ParamSpec>): Expr {
  const close: Expr = { op: "price", field: "close" };
  if (rng() < 0.2) {
    // anti-crowding gate: only trade when funding is below a crowd threshold.
    // WAVE-3a: sometimes gate on funding crowding z-score or an OI-expansion
    // regime (rising OI = real positioning behind the move) instead.
    const g = rng();
    if (g < 0.4) return { op: "lt", a: { op: "fundzscore" }, b: freshParam(params, 0.5, 2.5, 1.5, false) };
    if (g < 0.7) return { op: "gt", a: { op: "roc", src: { op: "oi" }, period: freshParam(params, 12, 96, 48) }, b: { op: "const", value: 0 } };
    return { op: "lt", a: { op: "funding" }, b: freshParam(params, 0.0001, 0.0008, 0.0003, false) };
  }
  if (rng() < 0.5) {
    // regime: price above/below long MA
    const ma: Expr = { op: "sma", src: close, period: freshParam(params, 100, 400, 200) };
    return { op: "gt", a: close, b: ma };
  }
  if (rng() < 0.55) {
    // CHOP-PROTECTION gate: trade only when the market is genuinely TRENDING (not
    // sideways/whipsawing). The canonical anti-whipsaw filters.
    const cg = rng();
    if (cg < 0.4) {
      // ADX > threshold: trend STRENGTH present (sit out chop)
      const period = freshParam(params, 7, 30, 14);
      return { op: "gt", a: { op: "adx", src: close, period }, b: freshParam(params, 18, 35, 25, false) };
    }
    if (cg < 0.75) {
      // Kaufman efficiency ratio > threshold: directional efficiency (clean trend)
      const period = freshParam(params, 10, 60, 20);
      return { op: "gt", a: { op: "effratio", src: close, period }, b: freshParam(params, 0.25, 0.6, 0.4, false) };
    }
    // Choppiness index BELOW threshold: not sideways
    const period = freshParam(params, 10, 30, 14);
    return { op: "lt", a: { op: "choppiness", src: close, period }, b: freshParam(params, 38, 60, 50, false) };
  }
  // vol regime: ATR pctrank below a cap (avoid chaos) or above a floor (need movement)
  const volRank: Expr = { op: "pctrank", src: { op: "atr", src: close, period: { op: "const", value: 14 } }, period: { op: "const", value: 150 } };
  const th = freshParam(params, 0.1, 0.9, 0.5, false);
  return rng() < 0.5 ? { op: "lt", a: volRank, b: th } : { op: "gt", a: volRank, b: th };
}

function genExit(rng: Rng, params: Record<string, ParamSpec>, entry: Expr): Expr {
  const close: Expr = { op: "price", field: "close" };
  const kind = rng();
  if (kind < 0.4) {
    // opposite MA relationship
    const ma: Expr = { op: pick(rng, SMOOTHERS), src: close, period: freshParam(params, 10, 100, 30) };
    return { op: "lt", a: close, b: ma };
  }
  if (kind < 0.7) {
    // channel exit: close < lowest(low, n) lagged
    const n = freshParam(params, 5, 80, 20);
    const ll: Expr = { op: "lag", src: { op: "lowest", src: { op: "price", field: "low" }, period: n }, period: { op: "const", value: 1 } };
    return { op: "lt", a: close, b: ll };
  }
  // momentum fade: roc < 0
  return { op: "lt", a: { op: "roc", src: close, period: freshParam(params, 3, 40, 10) }, b: { op: "const", value: 0 } };
}

// effective node + param count for the simplicity bias (fewer = strongly preferred).
function complexityOf(doc: StrategyDoc): { nodes: number; params: number } {
  const count = (e: unknown): number => {
    if (!e || typeof e !== "object") return 0;
    let n = 1; const o = e as Record<string, unknown>;
    for (const k of ["a", "b", "src", "period"]) if (o[k]) n += count(o[k]);
    return n;
  };
  return { nodes: count(doc.longEntry) + count(doc.longExit) + count(doc.shortEntry) + count(doc.shortExit), params: Object.keys(doc.params).length };
}

/**
 * MECHANISM-FIRST generation (the rebuilt discovery approach). Reasons top-down:
 * pick a coherent, economically-grounded MECHANISM template, instantiate it with
 * sampled params, sometimes combine two via a regime switch. A SMALL share stays
 * free-form GP for exploration. Simplicity is the bias — templates are 1-4 params,
 * and we reject anything that drifts above a tight node/param cap. Returns the
 * mechanism key for bandit/ledger attribution. This is how Daniel (and quants)
 * build strategies — vs the old bottom-up random-tree salads.
 */
export function mechanismFirstStrategy(seed: number, freeFormShare = 0.15): { doc: StrategyDoc; mechanism: string } {
  const rng = mulberry32(seed);
  for (let attempt = 0; attempt < 6; attempt++) {
    let r: { doc: StrategyDoc; mechanism: string };
    const roll = rng();
    if (roll < freeFormShare) {
      // small free-form exploration share (the old GP), but still simplicity-checked
      r = { doc: randomStrategy(seed + attempt * 13 + 1), mechanism: "fresh_freeform" };
    } else if (roll < freeFormShare + 0.18) {
      r = combineMechanisms(rng);                   // regime-switch combination
    } else {
      r = instantiateMechanism(rng);                // the bulk: instantiate a template
    }
    if (validateStrategy(r.doc).length > 0) continue;
    const cx = complexityOf(r.doc);
    // SIMPLICITY GATE: mechanism templates are simple; reject any drift (free-form
    // can produce bloat). Daniel's winner was 2 rules — keep generation lean.
    if (cx.nodes <= 26 && cx.params <= 5) return r;
  }
  // fallback: a guaranteed-simple template instance
  return instantiateMechanism(mulberry32(seed + 99));
}

/** keys of the mechanism library (for ideation context + reporting). */
export function mechanismKeys(): string[] { return MECHANISMS.map((m) => m.key); }

export function randomStrategy(seed: number): StrategyDoc {
  const rng = mulberry32(seed);
  const params: Record<string, ParamSpec> = {};
  const trigger = genTrigger(rng, params);
  const entry: Expr = rng() < 0.6 ? { op: "and", a: genFilter(rng, params), b: trigger } : trigger;
  const exit = genExit(rng, params, entry);
  const useShort = rng() < 0.5; // EMPHASIZED: ~half of fresh GP strategies are short-capable, so the tournament genuinely hunts the short space (squeeze cost is now priced in the backtester)
  const tfRoll = rng();
  const doc: StrategyDoc = {
    name: `gp_${seed.toString(36)}`,
    hypothesis: "GP-sampled: composition of trend/momentum/vol primitives; survives only if the gauntlet proves temporal structure.",
    tf: tfRoll < 0.5 ? "1h" : tfRoll < 0.85 ? "4h" : "1d",
    longEntry: entry,
    longExit: exit,
    shortEntry: useShort ? invertBool(entry) : undefined,
    shortExit: useShort ? invertBool(exit) : undefined,
    params: capParams(params),
    risk: {
      stopAtrMult: (useShort || rng() < 0.7) ? Number((1.5 + rng() * 2.5).toFixed(1)) : undefined, // short-capable strategies almost always carry an ATR stop (the thing that lets a short survive a squeeze)
      trailAtrMult: rng() < 0.4 ? Number((2 + rng() * 3).toFixed(1)) : undefined,
      // PROFIT trailing stop (let winners run, lock in profit): activate +10..40%,
      // trail 3..12% below the peak. ~30% of fresh strategies carry one.
      ...(rng() < 0.3 ? { trailActivate: Number((0.1 + rng() * 0.3).toFixed(2)), trailOffset: Number((0.03 + rng() * 0.09).toFixed(2)) } : {}),
      volTargetAnnual: Number((0.15 + rng() * 0.45).toFixed(2)), // leverage appetite is part of the genome
      maxLeverage: Number((1 + rng() * 3).toFixed(1)),
    },
  };
  return foldMissingParams(doc, params);
}

// ---------- mutation ----------
type AnyNode = Record<string, unknown> & { op: string };

function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)) as T; }

function collectNodes(e: Expr, out: AnyNode[] = []): AnyNode[] {
  const n = e as unknown as AnyNode;
  out.push(n);
  for (const k of ["src", "a", "b"]) if (n[k]) collectNodes(n[k] as Expr, out);
  return out;
}

const OP_SWAPS: Record<string, string[]> = {
  ema: ["sma", "wma"], sma: ["ema", "wma"], wma: ["ema", "sma"],
  gt: ["lt"], lt: ["gt"],
  crossover: ["crossunder"], crossunder: ["crossover"],
  highest: ["lowest"], lowest: ["highest"],
  zscore: ["pctrank"], pctrank: ["zscore"],
  add: ["sub"], sub: ["add"], min2: ["max2"], max2: ["min2"],
};

/** Steer the operator distribution by the parent's cause of death. */
export type MutationHint = "risk" | "consistency" | "generalize" | "sharpe" | undefined;

// The base mutation-operator families the bandit chooses among. Keys match the
// "gp-op:<op>" recipe keys in the knowledge ledger (without the prefix here).
export const MUTATION_OPS = [
  "op_swap", "param_shift", "add_filter", "remove_filter", "new_exit", "toggle_shorts", "risk_overlay",
] as const;
export type MutationOp = typeof MUTATION_OPS[number];

// Map a chosen operator family onto a `kind` value in the legacy threshold
// ladder, so the existing branch logic runs unchanged.
const OP_KIND: Record<MutationOp, number> = {
  op_swap: 0.1, param_shift: 0.3, add_filter: 0.47, remove_filter: 0.6, new_exit: 0.72, toggle_shorts: 0.83, risk_overlay: 0.95,
};

export interface BanditOpts {
  /** chosen operator family (recipe), or "" to use the legacy uniform ladder */
  forcedOp?: MutationOp | "";
}

/** Map a mutation string (returned by mutateStrategy) onto its recipe key for ledger attribution. */
export function recipeOf(source: string, mutation?: string): string {
  if (source === "crossover") return "crossover";
  if (source === "gp") return "fresh";
  if (source === "llm") return "llm";
  if (source === "seed") return "seed";
  if (source === "imported") return "imported";
  const m = mutation ?? "";
  if (m.startsWith("repair_")) return `gp-op:${m.split(":")[0]}`;        // repair_tighten_stop, repair_slow:p2 -> gp-op:repair_*
  if (m.startsWith("op_swap")) return "gp-op:op_swap";
  if (m.startsWith("param_shift")) return "gp-op:param_shift";
  if (m === "add_filter") return "gp-op:add_filter";
  if (m === "chop_gate") return "gp-op:chop_gate";
  if (m === "remove_filter") return "gp-op:remove_filter";
  if (m === "new_exit") return "gp-op:new_exit";
  if (m === "drop_shorts" || m === "add_shorts") return "gp-op:toggle_shorts";
  if (m.endsWith("profit_trail")) return "gp-op:profit_trail";
  if (m.startsWith("toggle_") || m.startsWith("leverage_") || m.startsWith("tf_shift")) return "gp-op:risk_overlay";
  return "gp-op:other";
}

export function mutateStrategy(parent: StrategyDoc, seed: number, hint?: MutationHint, bandit?: BanditOpts): { doc: StrategyDoc; mutation: string } {
  const rng = mulberry32(seed);
  for (let attempt = 0; attempt < 12; attempt++) {
    const doc = clone(parent);
    doc.name = `mut_${seed.toString(36)}`;
    let mutation = "";

    // ---- directed repairs: parent died on a specific floor ----
    if (hint === "risk" && rng() < 0.75) {
      // died on drawdown / worst-month: tame the risk overlay without touching the signal
      const r = doc.risk;
      const choice = rng();
      if (choice < 0.35) { r.stopAtrMult = Number((1.2 + rng() * 1.3).toFixed(1)); mutation = "repair_tighten_stop"; }
      else if (choice < 0.65) { r.trailAtrMult = Number((1.8 + rng() * 1.7).toFixed(1)); mutation = "repair_add_trail"; }
      else if (choice < 0.85) { r.volTargetAnnual = Number((0.15 + rng() * 0.08).toFixed(2)); mutation = "repair_lower_voltarget"; }
      else {
        const filter = genFilter(rng, doc.params);
        doc.longEntry = { op: "and", a: filter, b: doc.longEntry };
        if (doc.shortEntry) doc.shortEntry = { op: "and", a: invertBool(filter), b: doc.shortEntry };
        mutation = "repair_regime_gate";
      }
      const all = doc.params;
      doc.params = capParams(all);
      const folded = foldMissingParams(doc, all);
      folded.hypothesis = `${parent.hypothesis.slice(0, 140)} [repair: ${mutation}]`;
      if (validateStrategy(folded).length === 0) return { doc: folded, mutation };
      continue;
    }
    if (hint === "consistency" && rng() < 0.7) {
      // died on positive-months: slow the signal or gate it to calm regimes
      if (rng() < 0.5) {
        const keys = Object.keys(doc.params).filter((k) => doc.params[k].int);
        if (keys.length) {
          const k2 = pick(rng, keys);
          const ps = doc.params[k2];
          ps.default = Math.round(Math.min(ps.max * 2, ps.default * (1.4 + rng() * 0.8)));
          ps.max = Math.max(ps.max, ps.default);
          mutation = `repair_slow:${k2}`;
        }
      }
      if (!mutation) {
        const volRank: Expr = { op: "pctrank", src: { op: "atr", src: { op: "price", field: "close" }, period: { op: "const", value: 14 } }, period: { op: "const", value: 150 } };
        doc.longEntry = { op: "and", a: { op: "lt", a: volRank, b: freshParam(doc.params, 0.4, 0.9, 0.65, false) }, b: doc.longEntry };
        mutation = "repair_calm_gate";
      }
      const all = doc.params;
      doc.params = capParams(all);
      const folded = foldMissingParams(doc, all);
      folded.hypothesis = `${parent.hypothesis.slice(0, 140)} [repair: ${mutation}]`;
      if (validateStrategy(folded).length === 0) return { doc: folded, mutation };
      continue;
    }
    if (hint === "generalize" && rng() < 0.6) {
      // died cross-symbol/portfolio: strip the most BTC-specific structure — simplify
      const n = doc.longEntry as unknown as AnyNode;
      if (n.op === "and") {
        doc.longEntry = (rng() < 0.5 ? n.a : n.b) as Expr;
        mutation = "repair_simplify_entry";
      } else if (doc.params && Object.keys(doc.params).length > 2) {
        // widen param ranges so per-symbol re-tuning has room
        for (const ps of Object.values(doc.params)) { ps.min = ps.int ? Math.max(1, Math.round(ps.min * 0.6)) : ps.min * 0.6; ps.max = ps.int ? Math.round(ps.max * 1.5) : ps.max * 1.5; }
        mutation = "repair_widen_ranges";
      }
      if (mutation) {
        const all = doc.params;
        doc.params = capParams(all);
        const folded = foldMissingParams(doc, all);
        folded.hypothesis = `${parent.hypothesis.slice(0, 140)} [repair: ${mutation}]`;
        if (validateStrategy(folded).length === 0) return { doc: folded, mutation };
        continue;
      }
    }

    // bandit-driven operator choice: when a recipe is forced, snap `kind` to
    // that family's bucket; otherwise keep the legacy uniform ladder.
    const kind = bandit?.forcedOp ? OP_KIND[bandit.forcedOp] : rng();
    try {
      if (kind < 0.2) {
        // op swap somewhere
        const exprs = [doc.longEntry, doc.longExit, doc.shortEntry, doc.shortExit].filter(Boolean) as Expr[];
        const nodes = exprs.flatMap((e) => collectNodes(e)).filter((n) => OP_SWAPS[n.op]);
        if (!nodes.length) continue;
        const node = pick(rng, nodes);
        const newOp = pick(rng, OP_SWAPS[node.op]);
        mutation = `op_swap:${node.op}->${newOp}`;
        node.op = newOp;
      } else if (kind < 0.4) {
        // widen/shift a param's bounds + default
        const keys = Object.keys(doc.params);
        if (!keys.length) continue;
        const k = pick(rng, keys);
        const p = doc.params[k];
        const factor = 0.6 + rng() * 1.2;
        p.default = p.int ? Math.round(p.default * factor) : p.default * factor;
        p.min = Math.min(p.min, p.default);
        p.max = Math.max(p.max, p.default);
        mutation = `param_shift:${k}x${factor.toFixed(2)}`;
      } else if (kind < 0.48) {
        // add a generic regime filter conjunct to the entry
        const params = doc.params;
        const filter = genFilter(rng, params);
        doc.longEntry = { op: "and", a: filter, b: doc.longEntry };
        if (doc.shortEntry) doc.shortEntry = { op: "and", a: invertBool(filter), b: doc.shortEntry };
        mutation = "add_filter";
      } else if (kind < 0.55) {
        // CHOP-GATE: attach an explicit trend-quality / anti-whipsaw gate (ADX /
        // efficiency-ratio / choppiness) to BOTH long and short — sit out chop.
        const close: Expr = { op: "price", field: "close" };
        const cg = rng();
        const gate: Expr = cg < 0.4
          ? { op: "gt", a: { op: "adx", src: close, period: freshParam(doc.params, 7, 30, 14) }, b: freshParam(doc.params, 18, 35, 25, false) }
          : cg < 0.75
          ? { op: "gt", a: { op: "effratio", src: close, period: freshParam(doc.params, 10, 60, 20) }, b: freshParam(doc.params, 0.25, 0.6, 0.4, false) }
          : { op: "lt", a: { op: "choppiness", src: close, period: freshParam(doc.params, 10, 30, 14) }, b: freshParam(doc.params, 38, 60, 50, false) };
        doc.longEntry = { op: "and", a: gate, b: doc.longEntry };
        if (doc.shortEntry) doc.shortEntry = { op: "and", a: gate, b: doc.shortEntry };
        mutation = "chop_gate";
      } else if (kind < 0.65) {
        // remove a conjunct (simplify)
        const n = doc.longEntry as unknown as AnyNode;
        if (n.op !== "and") continue;
        doc.longEntry = (rng() < 0.5 ? n.a : n.b) as Expr;
        mutation = "remove_filter";
      } else if (kind < 0.78) {
        // replace the exit
        doc.longExit = genExit(rng, doc.params, doc.longEntry);
        if (doc.shortExit) doc.shortExit = invertBool(doc.longExit);
        mutation = "new_exit";
      } else if (kind < 0.88) {
        // direction flip: long-only -> add shorts, or invert
        if (doc.shortEntry) { doc.shortEntry = undefined; doc.shortExit = undefined; mutation = "drop_shorts"; }
        else { doc.shortEntry = invertBool(doc.longEntry); doc.shortExit = invertBool(doc.longExit); mutation = "add_shorts"; }
      } else {
        // risk/leverage/timeframe overlay tweak
        const r = doc.risk;
        const roll = rng();
        if (roll < 0.25) { r.stopAtrMult = r.stopAtrMult ? undefined : Number((1.5 + rng() * 2.5).toFixed(1)); mutation = "toggle_stop"; }
        else if (roll < 0.45) { r.trailAtrMult = r.trailAtrMult ? undefined : Number((2 + rng() * 3).toFixed(1)); mutation = "toggle_trail"; }
        else if (roll < 0.62) {
          // toggle / tune the PROFIT trailing stop (let-winners-run, lock-in-profit)
          if (r.trailActivate !== undefined && rng() < 0.5) {
            // tune the existing activate/offset levels
            r.trailActivate = Number(Math.min(0.6, Math.max(0.05, r.trailActivate * (0.7 + rng() * 0.9))).toFixed(2));
            r.trailOffset = Number(Math.min(0.2, Math.max(0.02, (r.trailOffset ?? 0.05) * (0.7 + rng() * 0.9))).toFixed(2));
            mutation = "tune_profit_trail";
          } else if (r.trailActivate !== undefined) {
            r.trailActivate = undefined; r.trailOffset = undefined; mutation = "drop_profit_trail";
          } else {
            r.trailActivate = Number((0.1 + rng() * 0.3).toFixed(2)); r.trailOffset = Number((0.03 + rng() * 0.09).toFixed(2)); mutation = "add_profit_trail";
          }
        }
        else if (roll < 0.82) {
          const f = 0.7 + rng() * 0.9;
          r.volTargetAnnual = Number(Math.min(0.6, Math.max(0.1, r.volTargetAnnual * f)).toFixed(2));
          r.maxLeverage = Number(Math.min(4, Math.max(1, r.maxLeverage * f)).toFixed(1));
          mutation = `leverage_x${f.toFixed(2)}`;
        } else {
          const tfs: ("1h" | "4h" | "1d")[] = ["1h", "4h", "1d"];
          const cur = doc.tf ?? "1h";
          doc.tf = pick(rng, tfs.filter((t) => t !== cur));
          mutation = `tf_shift:${cur}->${doc.tf}`;
        }
      }
      const all = doc.params;
      doc.params = capParams(all);
      const folded = foldMissingParams(doc, all);
      folded.hypothesis = `${parent.hypothesis.slice(0, 140)} [mutated: ${mutation}]`;
      if (validateStrategy(folded).length === 0) return { doc: folded, mutation };
    } catch { /* try again */ }
  }
  return { doc: clone(parent), mutation: "noop" };
}

export function crossoverStrategies(a: StrategyDoc, b: StrategyDoc, seed: number): StrategyDoc {
  const rng = mulberry32(seed);
  for (let attempt = 0; attempt < 8; attempt++) {
    const doc = clone(a);
    doc.name = `xo_${seed.toString(36)}`;
    // take entry from a, exit from b (or filter swap)
    const donor = clone(b);
    // merge params: rename donor params to avoid collisions
    const rename: Record<string, string> = {};
    for (const [k, p] of Object.entries(donor.params ?? {})) {
      const nk = `x_${k}`.slice(0, 24);
      rename[k] = nk;
      doc.params[nk] = p;
    }
    const renamed = (e: Expr): Expr => {
      const n = clone(e) as unknown as AnyNode;
      const walk = (m: AnyNode) => {
        if (m.op === "param") m.name = rename[m.name as string] ?? m.name;
        for (const k of ["src", "period", "a", "b"]) if (m[k]) walk(m[k] as AnyNode);
      };
      walk(n);
      return n as unknown as Expr;
    };
    if (rng() < 0.5) doc.longExit = renamed(donor.longExit);
    else doc.longEntry = { op: "and", a: doc.longEntry, b: renamed(donor.longEntry) };
    doc.shortEntry = undefined; doc.shortExit = undefined;
    const all = doc.params;
    doc.params = capParams(all);
    const folded = foldMissingParams(doc, all);
    folded.hypothesis = `Crossover of [${a.name}] and [${b.name}]: ${a.hypothesis.slice(0, 80)} + ${b.hypothesis.slice(0, 80)}`;
    if (validateStrategy(folded).length === 0) return folded;
  }
  return clone(a);
}

function invertBool(e: Expr): Expr {
  const n = e as unknown as AnyNode;
  if (n.op === "gt") return { ...(clone(n) as object), op: "lt" } as unknown as Expr;
  if (n.op === "lt") return { ...(clone(n) as object), op: "gt" } as unknown as Expr;
  if (n.op === "crossover") return { ...(clone(n) as object), op: "crossunder" } as unknown as Expr;
  if (n.op === "crossunder") return { ...(clone(n) as object), op: "crossover" } as unknown as Expr;
  if (n.op === "and") return { op: "and", a: invertBool(n.a as Expr), b: invertBool(n.b as Expr) };
  return { op: "not", a: clone(e) };
}

/** keep at most maxParams params: fold extras to consts at their defaults */
function capParams(params: Record<string, ParamSpec>): Record<string, ParamSpec> {
  const keys = Object.keys(params);
  if (keys.length <= 6) return params;
  // keep the 6 widest-range params (most tunable value), demote rest handled at validate time
  const ranked = keys.sort((x, y) => (params[y].max - params[y].min) / Math.max(1e-9, Math.abs(params[y].default)) - (params[x].max - params[x].min) / Math.max(1e-9, Math.abs(params[x].default)));
  const keep = new Set(ranked.slice(0, 6));
  const out: Record<string, ParamSpec> = {};
  for (const k of keys) if (keep.has(k)) out[k] = params[k];
  return out;
}

/** Replace param refs not present in spec with consts (after capParams). */
export function foldMissingParams(doc: StrategyDoc, defaults: Record<string, ParamSpec>): StrategyDoc {
  const d = clone(doc);
  const walk = (m: AnyNode) => {
    for (const k of ["src", "period", "a", "b"]) {
      if (!m[k]) continue;
      const child = m[k] as AnyNode;
      if (child.op === "param" && !d.params[child.name as string]) {
        const spec = defaults[child.name as string];
        (m as Record<string, unknown>)[k] = { op: "const", value: spec ? spec.default : 14 };
      } else walk(child);
    }
  };
  for (const e of [d.longEntry, d.longExit, d.shortEntry, d.shortExit]) if (e) walk(e as unknown as AnyNode);
  return d;
}
