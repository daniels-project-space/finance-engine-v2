// MECHANISM / TEMPLATE LIBRARY — mechanism-first, hypothesis-driven generation.
//
// The session's lesson: Daniel's ONE hand-built chop-gated SMA120 beat everything
// the bottom-up random-GP engine produced, because he reasoned TOP-DOWN (market
// structure -> mechanism -> simple implementation). This library encodes that: a
// curated set of economically-grounded, PARAMETERIZED templates, each a COHERENT
// mechanism with a documented "why". Generation instantiates / varies / combines
// these (see evolve.ts), instead of scrambling raw expression trees. SIMPLICITY is
// the bias — every template is 1-4 params and a handful of nodes (simple = robust).
//
// The gauntlet is UNCHANGED — it still judges these. This only changes WHAT we feed it.

import type { Expr, ParamSpec, StrategyDoc } from "./types";

type Rng = () => number;
const close: Expr = { op: "price", field: "close" };
const volume: Expr = { op: "price", field: "volume" };
let _pc = 0;
function P(params: Record<string, ParamSpec>, min: number, max: number, def: number, int = true): Expr {
  const name = `p${Object.keys(params).length}_${_pc++ % 1000}`;
  params[name] = { min, max, default: def, int };
  return { op: "param", name };
}
const pick = <T>(rng: Rng, a: readonly T[]): T => a[Math.floor(rng() * a.length)];
const ri = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const C = (v: number): Expr => ({ op: "const", value: v });
const gt = (a: Expr, b: Expr): Expr => ({ op: "gt", a, b });
const lt = (a: Expr, b: Expr): Expr => ({ op: "lt", a, b });
const and = (a: Expr, b: Expr): Expr => ({ op: "and", a, b });
const sma = (src: Expr, p: Expr): Expr => ({ op: "sma", src, period: p });
const ema = (src: Expr, p: Expr): Expr => ({ op: "ema", src, period: p });
const ma = (rng: Rng, src: Expr, p: Expr): Expr => (rng() < 0.5 ? sma(src, p) : ema(src, p));

export interface MechanismTemplate {
  /** stable mechanism key (bandit/ledger attribution + library reference) */
  key: string;
  /** human title */
  title: string;
  /** the market-structure RATIONALE — WHY this edge should exist */
  rationale: string;
  /** instantiate the template with freshly sampled params */
  build: (rng: Rng) => StrategyDoc;
}

// each builder returns a coherent, SIMPLE StrategyDoc. tf sampled per-template.
const TF = (rng: Rng): "1h" | "4h" | "1d" => (rng() < 0.45 ? "1d" : rng() < 0.8 ? "4h" : "1h");

// ---------------------------------------------------------------- the library
export const MECHANISMS: MechanismTemplate[] = [
  {
    key: "trend_chop_gated",
    title: "Trend + chop/regime filter (Daniel's winner)",
    rationale: "Markets trend or chop. A moving-average trend signal works in trends but whipsaws in sideways chop. Gate it on a genuine-trend filter (ADX>thr OR choppiness<thr) so we only ride trends and sit in cash during chop. Long-flat. This is the chop-gated SMA that beat buy-and-hold.",
    build: (rng) => {
      const params: Record<string, ParamSpec> = {};
      const maWin = P(params, 60, 250, pick(rng, [100, 120, 150, 200]));
      const useAdx = rng() < 0.5;
      const trendGate: Expr = useAdx
        ? gt({ op: "adx", src: close, period: C(14) }, P(params, 18, 32, 25, false))
        : lt({ op: "choppiness", src: close, period: C(14) }, P(params, 38, 58, 50, false));
      const aboveMA = gt(close, ma(rng, close, maWin));
      return {
        name: `mech_trendchop_${rng().toString(36).slice(2, 7)}`,
        tf: TF(rng),
        hypothesis: `Trend + chop filter: long only when price is above its MA AND the market is genuinely trending (${useAdx ? "ADX>threshold" : "choppiness<threshold"}), else cash. Rides trends, sits out whipsaw chop. ${"Daniel's chop-gated mechanism."}`,
        longEntry: and(aboveMA, trendGate),
        longExit: lt(close, ma(rng, close, maWin)),
        params,
        risk: { volTargetAnnual: Number((0.25 + rng() * 0.25).toFixed(2)), maxLeverage: 1, ...(rng() < 0.5 ? { stopAtrMult: Number((2 + rng() * 2).toFixed(1)) } : {}) },
      };
    },
  },
  {
    key: "breakout_vol_trail",
    title: "Breakout + volume confirmation + trailing stop (SOL kernel)",
    rationale: "A breakout to new highs is real only if backed by participation. Require price > prior N-day high AND a volume surge (volume z-score>0) AND (optionally) a bull regime (close>slow MA). Let the winner run with a profit trailing stop. The Wyckoff markup mechanism — the salvageable SOL kernel.",
    build: (rng) => {
      const params: Record<string, ParamSpec> = {};
      const lookback = P(params, 20, 80, pick(rng, [30, 50, 60]));
      const breakout = gt(close, { op: "lag", src: { op: "highest", src: close, period: lookback }, period: C(1) });
      const volConfirm = gt({ op: "zscore", src: volume, period: C(30) }, C(0));
      const bull = rng() < 0.6 ? gt(close, sma(close, C(200))) : null;
      const entry = bull ? and(and(breakout, volConfirm), bull) : and(breakout, volConfirm);
      return {
        name: `mech_breakout_${rng().toString(36).slice(2, 7)}`,
        tf: TF(rng),
        hypothesis: "Volume-confirmed breakout: price breaks to new highs on rising volume (real participation, Wyckoff markup), then a profit trailing stop lets the winner run and locks gains. Exits on a slow-MA break.",
        longEntry: entry,
        longExit: lt(close, { op: "lowest", src: close, period: P(params, 60, 150, 100) }),
        params,
        risk: { volTargetAnnual: Number((0.3 + rng() * 0.2).toFixed(2)), maxLeverage: 1, stopAtrMult: Number((2.5 + rng()).toFixed(1)), trailActivate: Number((0.15 + rng() * 0.25).toFixed(2)), trailOffset: Number((0.05 + rng() * 0.07).toFixed(2)) },
      };
    },
  },
  {
    key: "meanrev_range",
    title: "Mean-reversion in a range regime",
    rationale: "In a RANGE (low ADX / high choppiness), price oscillates and reverts; momentum fails. Buy oversold (short RSI low) ONLY when the market is ranging, exit on reversion to the mean. The opposite regime to trend-following — they're complementary.",
    build: (rng) => {
      const params: Record<string, ParamSpec> = {};
      const rsiWin = P(params, 2, 14, pick(rng, [2, 3, 5]));
      const oversold = P(params, 5, 35, ri(rng, 10, 25), false);
      const rangeGate = rng() < 0.5 ? lt({ op: "adx", src: close, period: C(14) }, P(params, 15, 25, 20, false)) : gt({ op: "choppiness", src: close, period: C(14) }, P(params, 50, 65, 55, false));
      return {
        name: `mech_meanrev_${rng().toString(36).slice(2, 7)}`,
        tf: TF(rng),
        hypothesis: "Range mean-reversion: when the market is RANGING (low ADX / high choppiness), buy short-term oversold (low RSI) and exit on reversion. Harvests the oscillation that defeats trend-followers in chop.",
        longEntry: and(lt({ op: "rsi", src: close, period: rsiWin }, oversold), rangeGate),
        longExit: gt({ op: "rsi", src: close, period: rsiWin }, P(params, 45, 70, 55, false)),
        params,
        risk: { volTargetAnnual: Number((0.2 + rng() * 0.2).toFixed(2)), maxLeverage: 1, stopAtrMult: Number((2 + rng() * 1.5).toFixed(1)) },
      };
    },
  },
  {
    key: "tsmom_trend",
    title: "Time-series momentum + trend filter (TSMOM)",
    rationale: "Time-series momentum is one of the most robust cross-asset premia: assets that rose over the last K months tend to keep rising. Go long when the trailing K-period return is positive AND price is above a slow MA (regime confirm). Simple, well-documented edge.",
    build: (rng) => {
      const params: Record<string, ParamSpec> = {};
      const lb = P(params, 30, 180, pick(rng, [60, 90, 120]));
      const momPos = gt({ op: "roc", src: close, period: lb }, C(0));
      const trend = gt(close, ma(rng, close, P(params, 100, 250, 200)));
      return {
        name: `mech_tsmom_${rng().toString(36).slice(2, 7)}`,
        tf: TF(rng),
        hypothesis: "Time-series momentum + trend filter: long when the trailing return is positive AND price is in an uptrend (above slow MA). The robust cross-asset TSMOM premium, regime-confirmed to avoid bear-market head-fakes.",
        longEntry: and(momPos, trend),
        longExit: lt({ op: "roc", src: close, period: lb }, C(0)),
        params,
        risk: { volTargetAnnual: Number((0.25 + rng() * 0.25).toFixed(2)), maxLeverage: 1, ...(rng() < 0.5 ? { trailActivate: 0.25, trailOffset: 0.08 } : {}) },
      };
    },
  },
  {
    key: "vol_regime_size",
    title: "Vol-regime trend (size by realized-vol percentile)",
    rationale: "Crypto vol clusters and mean-reverts. Trend signals are cleaner in low-to-moderate vol; extreme high-vol = chaos/reversal risk. Trade the trend but ONLY when realized-vol percentile is below a cap (avoid the chaos), implicitly de-risking before blow-ups.",
    build: (rng) => {
      const params: Record<string, ParamSpec> = {};
      const volRank: Expr = { op: "pctrank", src: { op: "atr", src: close, period: C(14) }, period: C(150) };
      const trend = gt(close, ma(rng, close, P(params, 100, 250, 150)));
      const calmGate = lt(volRank, P(params, 50, 90, 75, false));
      return {
        name: `mech_volregime_${rng().toString(36).slice(2, 7)}`,
        tf: TF(rng),
        hypothesis: "Vol-regime trend: ride the trend (price>MA) only when realized vol is NOT in its extreme upper percentile — sit out the chaos/blow-up regime where trends break violently. Implicit de-risking before crashes.",
        longEntry: and(trend, calmGate),
        longExit: lt(close, ma(rng, close, P(params, 100, 250, 150))),
        params,
        risk: { volTargetAnnual: Number((0.3 + rng() * 0.2).toFixed(2)), maxLeverage: 1, stopAtrMult: Number((2.5 + rng()).toFixed(1)) },
      };
    },
  },
  {
    key: "donchian_trend",
    title: "Donchian breakout + trend filter",
    rationale: "The classic turtle channel breakout: enter when price breaks the N-day high, exit on the M-day low, but only in a confirmed uptrend (price>slow MA) so you don't buy false breakouts in a downtrend. Robust, few params.",
    build: (rng) => {
      const params: Record<string, ParamSpec> = {};
      const entWin = P(params, 20, 80, pick(rng, [20, 40, 55]));
      const exitWin = P(params, 10, 40, pick(rng, [10, 20]));
      const trend = gt(close, sma(close, C(200)));
      return {
        name: `mech_donchian_${rng().toString(36).slice(2, 7)}`,
        tf: TF(rng),
        hypothesis: "Donchian breakout + trend filter: buy the N-day high breakout, exit on the M-day low, only when above the 200-MA (confirmed uptrend) to skip false breakouts in bear markets. The turtle channel, regime-gated.",
        longEntry: and(gt(close, { op: "lag", src: { op: "highest", src: close, period: entWin }, period: C(1) }), trend),
        longExit: lt(close, { op: "lowest", src: close, period: exitWin }),
        params,
        risk: { volTargetAnnual: Number((0.25 + rng() * 0.25).toFixed(2)), maxLeverage: 1, ...(rng() < 0.5 ? { trailActivate: Number((0.2 + rng() * 0.2).toFixed(2)), trailOffset: 0.07 } : {}) },
      };
    },
  },
  {
    key: "carry_funding_tilt",
    title: "Funding carry tilt (long in backwardation)",
    rationale: "Perp funding reflects positioning crowding. Persistently NEGATIVE funding (shorts pay longs) = a carry premium for being long, often near capitulation bottoms; extreme POSITIVE funding = crowded longs (avoid). Tilt long when funding is low/negative AND price isn't breaking down (trend confirm).",
    build: (rng) => {
      const params: Record<string, ParamSpec> = {};
      const lowFunding = lt({ op: "fundzscore" }, P(params, -0.5, 0.5, 0, false));
      const notBreakingDown = gt(close, sma(close, P(params, 40, 120, 50)));
      return {
        name: `mech_carry_${rng().toString(36).slice(2, 7)}`,
        tf: TF(rng),
        hypothesis: "Funding-carry tilt: long when funding is low/negative (shorts pay longs = carry premium, often near bottoms) AND price holds above a medium MA (not breaking down). Harvests the perp carry / crowding-unwind premium.",
        longEntry: and(lowFunding, notBreakingDown),
        longExit: lt(close, sma(close, P(params, 40, 120, 50))),
        params,
        risk: { volTargetAnnual: Number((0.2 + rng() * 0.2).toFixed(2)), maxLeverage: 1, stopAtrMult: Number((2 + rng() * 1.5).toFixed(1)) },
      };
    },
  },
];

export function mechanismByKey(key: string): MechanismTemplate | undefined {
  return MECHANISMS.find((m) => m.key === key);
}

/** Instantiate a random mechanism template (the BULK of mechanism-first generation). */
export function instantiateMechanism(rng: Rng): { doc: StrategyDoc; mechanism: string } {
  const t = pick(rng, MECHANISMS);
  const doc = t.build(rng);
  doc.hypothesis = `${doc.hypothesis} [mechanism: ${t.key}]`;
  return { doc, mechanism: t.key };
}

/** COMBINE two mechanisms via a regime switch: trend-template signal when trending,
 *  mean-rev-template signal when ranging — one strategy, regime-conditional. Kept
 *  simple: AND the trend mechanism's entry with a trend-regime gate. */
export function combineMechanisms(rng: Rng): { doc: StrategyDoc; mechanism: string } {
  // pick a trend-ish primary + add an explicit regime split note
  const trendT = pick(rng, MECHANISMS.filter((m) => ["trend_chop_gated", "tsmom_trend", "donchian_trend"].includes(m.key)));
  const doc = trendT.build(rng);
  doc.name = `mech_switch_${rng().toString(36).slice(2, 7)}`;
  doc.hypothesis = `Regime-switch: ${trendT.title} as the trend leg, conditioned on a trending regime (the complementary range leg flat for now). One regime-aware strategy. [mechanism: regime_switch:${trendT.key}]`;
  return { doc, mechanism: `regime_switch:${trendT.key}` };
}
