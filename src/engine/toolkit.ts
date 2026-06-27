// TOOLKIT MACROS — a shared library of PROVEN, parameterized DSL building blocks.
//
// The capability audit found the engine "rediscovers" the same proven sub-graphs
// node-by-node: every mechanism template re-inlines "price above its slow MA", the
// GP re-inlines a chop gate (`chop_gate`) and a vol-calm gate (`repair_calm_gate`),
// and the LLM is only told about them in prose. This file makes those blocks a
// SINGLE named catalog that all three generators compose from — so generation
// starts from Daniel-style building blocks instead of scrambling raw nodes.
//
// A MACRO is a parameterized boolean sub-graph with an economic rationale. GATE
// macros AND onto an existing entry (a confirm/filter); BASE signals are standalone
// entry+exit triggers. Nothing here changes the gauntlet — it only changes WHAT we
// feed it. Note: position-scaling blocks (DCA ladders) are NOT expressible in this
// binary-state DSL; those live in the on-chain/blend sleeves, not here.

import type { Expr, ParamSpec, StrategyDoc } from "./types";

type Rng = () => number;

/** A param factory the CALLER supplies so param names never collide with the host
 *  doc's existing params. evolve passes one bound to `freshParam(doc.params,...)`;
 *  composeFromToolkit builds its own. Returns a {op:"param"} Expr. */
export type MkParam = (min: number, max: number, def: number, int?: boolean) => Expr;

const close: Expr = { op: "price", field: "close" };
const volume: Expr = { op: "price", field: "volume" };
const C = (v: number): Expr => ({ op: "const", value: v });
const gt = (a: Expr, b: Expr): Expr => ({ op: "gt", a, b });
const lt = (a: Expr, b: Expr): Expr => ({ op: "lt", a, b });
const and = (a: Expr, b: Expr): Expr => ({ op: "and", a, b });
const sma = (src: Expr, p: Expr): Expr => ({ op: "sma", src, period: p });
const ema = (src: Expr, p: Expr): Expr => ({ op: "ema", src, period: p });
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
const maybeEma = (rng: Rng, src: Expr, p: Expr): Expr => (rng() < 0.5 ? sma(src, p) : ema(src, p));

// which regime a block belongs to — so the composer only pairs compatible blocks
// (trend gates onto trend signals; the range gate onto mean-reversion).
export type Regime = "trend" | "range" | "any";

export interface Macro {
  key: string;
  title: string;
  /** the market-structure RATIONALE — WHY this block is an edge (shown to the LLM). */
  rationale: string;
  regime: Regime;
  /** true  => the gate applies IDENTICALLY on a short side (regime-symmetric: you
   *           want a trending/calm/ranging market regardless of direction).
   *  false => directional: the short side must use the INVERSE (a long trend-confirm
   *           becomes a down-trend confirm). The host inverts via its own invertBool. */
  symmetric: boolean;
  build: (rng: Rng, P: MkParam) => Expr;
}

// ------------------------------------------------------- GATE / CONFIRM macros
// Each is a boolean sub-graph you AND onto an entry to confirm/filter it.
export const GATE_MACROS: Macro[] = [
  {
    key: "trend_confirm",
    title: "Trend confirm (price above slow MA)",
    rationale: "The 200-MA-style regime filter: only be long when price is above its slow moving average (a confirmed uptrend), so signals never fire into a bear market. Daniel's blend and most survivors carry this.",
    regime: "trend",
    symmetric: false,
    build: (rng, P) => gt(close, maybeEma(rng, close, P(80, 250, pick(rng, [100, 150, 200]), true))),
  },
  {
    key: "trend_quality_gate",
    title: "Trend-quality / anti-chop gate (ADX | efficiency | choppiness)",
    rationale: "Markets trend or chop; a trend signal whipsaws in chop. Act only when the market is GENUINELY trending — ADX>thr OR Kaufman efficiency>thr OR choppiness<thr. Sit out sideways. This is the gate in Daniel's winner.",
    regime: "trend",
    symmetric: true,
    build: (rng, P) => {
      const r = rng();
      return r < 0.4
        ? gt({ op: "adx", src: close, period: P(7, 30, 14, true) }, P(18, 35, 25, false))
        : r < 0.75
          ? gt({ op: "effratio", src: close, period: P(10, 60, 20, true) }, P(0.25, 0.6, 0.4, false))
          : lt({ op: "choppiness", src: close, period: P(10, 30, 14, true) }, P(38, 60, 50, false));
    },
  },
  {
    key: "vol_calm_gate",
    title: "Vol-calm gate (realized-vol percentile below a cap)",
    rationale: "Crypto vol clusters and trends break violently in extreme-vol regimes. Trade only when the ATR percentile is below a cap — implicit de-risking before blow-ups.",
    regime: "any",
    symmetric: true,
    build: (_rng, P) => lt({ op: "pctrank", src: { op: "atr", src: close, period: C(14) }, period: C(150) }, P(50, 90, 75, false)),
  },
  {
    key: "range_gate",
    title: "Range gate (low ADX / high choppiness) — for mean-reversion",
    rationale: "The complement of the trend gate: mean-reversion only works when the market is RANGING (low ADX / high choppiness). Gate reversion entries on a range regime so they don't fight a live trend.",
    regime: "range",
    symmetric: true,
    build: (rng, P) => (rng() < 0.5
      ? lt({ op: "adx", src: close, period: C(14) }, P(15, 25, 20, false))
      : gt({ op: "choppiness", src: close, period: C(14) }, P(50, 65, 55, false))),
  },
  {
    key: "vol_surge_confirm",
    title: "Volume-surge confirm (Wyckoff participation)",
    rationale: "A move is real only with participation: require volume z-score>0 (effort behind the result). Confirms breakouts/markup and filters low-conviction drift.",
    regime: "trend",
    symmetric: true,
    build: (_rng, P) => gt({ op: "zscore", src: volume, period: C(30) }, P(-0.2, 1.0, 0, false)),
  },
  {
    key: "momentum_positive",
    title: "Momentum confirm (trailing return positive)",
    rationale: "Time-series momentum: the trailing K-period return is positive. The robust cross-asset TSMOM premium used as a confirm leg.",
    regime: "trend",
    symmetric: false,
    build: (rng, P) => gt({ op: "roc", src: close, period: P(30, 180, pick(rng, [60, 90, 120]), true) }, C(0)),
  },
  {
    key: "funding_low_tilt",
    title: "Funding-low tilt (carry / crowding unwind)",
    rationale: "Persistently low/negative funding = shorts pay longs (a carry premium, often near capitulation); extreme positive = crowded longs. Tilt long when the funding z-score is low.",
    regime: "any",
    symmetric: false,
    build: (_rng, P) => lt({ op: "fundzscore" }, P(-0.5, 0.5, 0, false)),
  },
  {
    key: "not_overbought",
    title: "Not-overbought guard (don't chase a blow-off)",
    rationale: "Avoid entering a long into a short-term blow-off: require RSI below an upper bound so entries are not at local froth.",
    regime: "any",
    symmetric: false,
    build: (_rng, P) => lt({ op: "rsi", src: close, period: C(14) }, P(60, 85, 72, false)),
  },
];

export function gateByKey(key: string): Macro | undefined {
  return GATE_MACROS.find((m) => m.key === key);
}

/** Pick a gate macro, optionally constrained to a regime compatible with a base. */
export function pickGateMacro(rng: Rng, regime: Regime = "any"): Macro {
  const pool = regime === "any" ? GATE_MACROS : GATE_MACROS.filter((m) => m.regime === regime || m.regime === "any");
  return pick(rng, pool.length ? pool : GATE_MACROS);
}

// --------------------------------------------------------------- BASE signals
// Standalone entry+exit triggers. Each shares its window param between entry/exit
// where it makes structural sense (e.g. cross above the MA / cross back below it).
export interface BaseSignal {
  key: string;
  title: string;
  regime: Regime;
  build: (rng: Rng, P: MkParam) => { entry: Expr; exit: Expr };
}

export const BASE_SIGNALS: BaseSignal[] = [
  {
    key: "ma_trend",
    title: "MA trend (cross above its MA / back below)",
    regime: "trend",
    build: (rng, P) => {
      const w = P(40, 200, pick(rng, [50, 100, 120]), true);
      const useEma = rng() < 0.5;
      const m = useEma ? ema(close, w) : sma(close, w);
      return { entry: gt(close, m), exit: lt(close, m) };
    },
  },
  {
    key: "donchian_breakout",
    title: "Donchian breakout (prior N-high / exit on M-low)",
    regime: "trend",
    build: (rng, P) => ({
      entry: gt(close, { op: "lag", src: { op: "highest", src: close, period: P(20, 80, pick(rng, [20, 40, 55]), true) }, period: C(1) }),
      exit: lt(close, { op: "lowest", src: close, period: P(10, 40, pick(rng, [10, 20]), true) }),
    }),
  },
  {
    key: "tsmom",
    title: "Time-series momentum (trailing return sign)",
    regime: "trend",
    build: (rng, P) => {
      const lb = P(30, 180, pick(rng, [60, 90, 120]), true);
      return { entry: gt({ op: "roc", src: close, period: lb }, C(0)), exit: lt({ op: "roc", src: close, period: lb }, C(0)) };
    },
  },
  {
    key: "rsi_meanrev",
    title: "RSI mean-reversion (buy oversold / exit on reversion)",
    regime: "range",
    build: (rng, P) => {
      const w = P(2, 14, pick(rng, [2, 3, 5]), true);
      return { entry: lt({ op: "rsi", src: close, period: w }, P(5, 35, 20, false)), exit: gt({ op: "rsi", src: close, period: w }, P(45, 70, 55, false)) };
    },
  },
];

// ----------------------------------------------------- compose a full strategy
// Build a coherent strategy ENTIRELY from proven blocks: one base signal + 1-2
// regime-compatible gates. This is the mechanism-first idea expressed as block
// composition. Self-contained param factory so names never collide.
let _tc = 0;
function makeMk(params: Record<string, ParamSpec>): MkParam {
  return (min, max, def, int = true) => {
    const name = `p${Object.keys(params).length}_${_tc++ % 100000}`;
    params[name] = { min, max, default: def, int };
    return { op: "param", name };
  };
}
const TF = (rng: Rng): "1h" | "4h" | "1d" => (rng() < 0.45 ? "1d" : rng() < 0.8 ? "4h" : "1h");

export function composeFromToolkit(seed: number): { doc: StrategyDoc; macros: string[] } {
  const rng = mulberry32(seed);
  const params: Record<string, ParamSpec> = {};
  const P = makeMk(params);
  const base = pick(rng, BASE_SIGNALS);
  const { entry, exit } = base.build(rng, P);

  // 1-2 gates from the base's regime (range bases get the range gate / vol-calm;
  // trend bases get trend-confirm / trend-quality / vol-surge / momentum).
  const nGates = rng() < 0.65 ? 1 : 2;
  const used = new Set<string>();
  let longEntry = entry;
  const macros: string[] = [`base:${base.key}`];
  for (let i = 0; i < nGates; i++) {
    const g = pickGateMacro(rng, base.regime);
    if (used.has(g.key)) continue;
    used.add(g.key);
    longEntry = and(g.build(rng, P), longEntry);
    macros.push(g.key);
  }

  const why = GATE_MACROS.filter((m) => used.has(m.key)).map((m) => m.title).join(" + ");
  const doc: StrategyDoc = {
    name: `toolkit_${seed.toString(36).slice(-5)}`,
    tf: TF(rng),
    hypothesis: `Toolkit composition — ${base.title} confirmed by ${why || "no gate"}. Built from proven blocks (not raw nodes): the base provides the signal, the gate(s) supply regime/participation confirmation so it rides real moves and sits out chop.`,
    longEntry,
    longExit: exit,
    params,
    risk: {
      volTargetAnnual: Number((0.22 + rng() * 0.26).toFixed(2)),
      maxLeverage: 1,
      ...(rng() < 0.5 ? { stopAtrMult: Number((2 + rng() * 1.8).toFixed(1)) } : {}),
      ...(base.regime === "trend" && rng() < 0.4 ? { trailActivate: Number((0.18 + rng() * 0.22).toFixed(2)), trailOffset: Number((0.05 + rng() * 0.06).toFixed(2)) } : {}),
    },
  };
  return { doc, macros };
}

// minimal local PRNG (mirrors evolve/mechanisms — deterministic per seed).
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----------------------------------------------------- LLM prompt catalog text
// Formalizes the proven blocks BY NAME so the LLM composes from the same toolkit
// the GP grafts — not just prose archetypes.
export const MACRO_CATALOG_TEXT = `## Toolkit of proven building blocks (compose from these by name; combine a BASE with 1-2 GATES)
BASE signals (the trigger):
${BASE_SIGNALS.map((b) => ` - ${b.key} — ${b.title} [${b.regime}]`).join("\n")}
GATE/CONFIRM blocks (AND onto the base to confirm/filter — directional gates invert for shorts):
${GATE_MACROS.map((m) => ` - ${m.key} — ${m.title}: ${m.rationale}`).join("\n")}
A robust strategy is usually ONE base + a trend-quality or trend-confirm gate (+ optionally a vol/participation confirm). Pair range bases (rsi_meanrev) with range_gate, trend bases with the trend gates. Keep it to 1-4 params.`;
