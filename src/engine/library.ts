// Curated seed library: research-backed strategy families expressed in the DSL.
// These are the gene pool's founders — every entry cites the mechanism it
// exploits and ships with canonical parameter ranges. They get NO special
// treatment: each fights the same gauntlet, and the ranking they earn anchors
// all subsequent evolution (mutation/crossover parents come from the board).

import type { Expr, ParamSpec, RiskSpec, StrategyDoc } from "./types";

// ---- tiny builders to keep the graphs readable ----
const c: Expr = { op: "price", field: "close" };
const h: Expr = { op: "price", field: "high" };
const l: Expr = { op: "price", field: "low" };
const open: Expr = { op: "price", field: "open" };
const k = (value: number): Expr => ({ op: "const", value });
const P = (name: string): Expr => ({ op: "param", name });
const ema = (src: Expr, period: Expr): Expr => ({ op: "ema", src, period });
const sma = (src: Expr, period: Expr): Expr => ({ op: "sma", src, period });
const rsi = (src: Expr, period: Expr): Expr => ({ op: "rsi", src, period });
const atr = (period: Expr): Expr => ({ op: "atr", src: c, period });
const stdev = (src: Expr, period: Expr): Expr => ({ op: "stdev", src, period });
const highest = (src: Expr, period: Expr): Expr => ({ op: "highest", src, period });
const lowest = (src: Expr, period: Expr): Expr => ({ op: "lowest", src, period });
const lag = (src: Expr, n: number): Expr => ({ op: "lag", src, period: k(n) });
const roc = (src: Expr, period: Expr): Expr => ({ op: "roc", src, period });
const zscore = (src: Expr, period: Expr): Expr => ({ op: "zscore", src, period });
const pctrank = (src: Expr, period: Expr): Expr => ({ op: "pctrank", src, period });
const add = (a: Expr, b: Expr): Expr => ({ op: "add", a, b });
const sub = (a: Expr, b: Expr): Expr => ({ op: "sub", a, b });
const mul = (a: Expr, b: Expr): Expr => ({ op: "mul", a, b });
const div = (a: Expr, b: Expr): Expr => ({ op: "div", a, b });
const max2 = (a: Expr, b: Expr): Expr => ({ op: "max2", a, b });
const gt = (a: Expr, b: Expr): Expr => ({ op: "gt", a, b });
const lt = (a: Expr, b: Expr): Expr => ({ op: "lt", a, b });
const crossover = (a: Expr, b: Expr): Expr => ({ op: "crossover", a, b });
const crossunder = (a: Expr, b: Expr): Expr => ({ op: "crossunder", a, b });
const and = (a: Expr, b: Expr): Expr => ({ op: "and", a, b });

const TREND_RISK: RiskSpec = { volTargetAnnual: 0.25, maxLeverage: 2, trailAtrMult: 4 };
const BREAKOUT_RISK: RiskSpec = { volTargetAnnual: 0.25, maxLeverage: 2, stopAtrMult: 2.5, trailAtrMult: 3.5 };
const MEANREV_RISK: RiskSpec = { volTargetAnnual: 0.25, maxLeverage: 2, stopAtrMult: 3 };

const p = (min: number, max: number, def: number, int = true): ParamSpec => ({ min, max, default: def, int });

export const SEED_LIBRARY: StrategyDoc[] = [
  // ------------------------------------------------------------- TREND
  {
    name: "seed_ewmac_carver",
    hypothesis: "EWMAC (Carver, 'Systematic Trading'; Lemperiere et al. 2014 show two centuries of trend across assets): information diffuses slowly and herding extends moves, so an EMA crossover captures persistent drift. Symmetric long/short.",
    longEntry: crossover(ema(c, P("fast")), ema(c, P("slow"))),
    longExit: crossunder(ema(c, P("fast")), ema(c, P("slow"))),
    shortEntry: crossunder(ema(c, P("fast")), ema(c, P("slow"))),
    shortExit: crossover(ema(c, P("fast")), ema(c, P("slow"))),
    params: { fast: p(8, 32, 16), slow: p(48, 160, 64) },
    risk: TREND_RISK,
  },
  {
    name: "seed_turtle_donchian",
    hypothesis: "Turtle/Donchian channel breakout (Dennis & Eckhardt; Faith 'Way of the Turtle'): N-bar highs mark information arrival plus stop-driven flows; asymmetric exit channel rides the move. 2-ATR initial stop mirrors the turtles' 2N rule.",
    longEntry: gt(c, lag(highest(h, P("entryN")), 1)),
    longExit: lt(c, lag(lowest(l, P("exitN")), 1)),
    shortEntry: lt(c, lag(lowest(l, P("entryN")), 1)),
    shortExit: gt(c, lag(highest(h, P("exitN")), 1)),
    params: { entryN: p(15, 80, 20), exitN: p(5, 40, 10) },
    risk: { volTargetAnnual: 0.25, maxLeverage: 2, stopAtrMult: 2 },
  },
  {
    name: "seed_tsmom",
    hypothesis: "Time-series momentum (Moskowitz, Ooi & Pedersen 2012): an asset's own trailing return predicts its next-month return across every liquid asset class; crypto exhibits the strongest documented TSMOM. Sign of trailing return sets direction.",
    longEntry: gt(roc(c, P("look")), k(0)),
    longExit: lt(roc(c, P("look")), k(0)),
    shortEntry: lt(roc(c, P("look")), k(0)),
    shortExit: gt(roc(c, P("look")), k(0)),
    params: { look: p(120, 500, 336) },
    risk: TREND_RISK,
  },
  {
    name: "seed_macd_trend",
    hypothesis: "MACD momentum (Appel) gated by the 200-bar regime filter: signal-line crossovers time entries inside an established uptrend, avoiding counter-trend whipsaw. Long-only — the filter is the edge, the oscillator is the trigger.",
    longEntry: and(
      gt(c, sma(c, P("regime"))),
      crossover(sub(ema(c, P("fast")), ema(c, P("slow"))), ema(sub(ema(c, P("fast")), ema(c, P("slow"))), P("signal"))),
    ),
    longExit: crossunder(sub(ema(c, P("fast")), ema(c, P("slow"))), ema(sub(ema(c, P("fast")), ema(c, P("slow"))), P("signal"))),
    params: { fast: p(8, 16, 12), slow: p(20, 40, 26), signal: p(5, 14, 9), regime: p(120, 400, 200) },
    risk: TREND_RISK,
  },
  {
    name: "seed_high_anchor",
    hypothesis: "Anchoring to the trailing high (George & Hwang 2004): traders under-react near salient reference highs, so price grinding within a few percent of the N-bar high continues up after the anchor breaks. Exit when proximity decays.",
    longEntry: gt(div(c, highest(h, P("look"))), P("nearTh")),
    longExit: lt(div(c, highest(h, P("look"))), P("exitTh")),
    params: { look: p(200, 500, 400), nearTh: { min: 0.95, max: 0.999, default: 0.985 }, exitTh: { min: 0.8, max: 0.95, default: 0.9 } },
    risk: TREND_RISK,
  },
  {
    name: "seed_vol_regime_trend",
    hypothesis: "Trend filtered by volatility regime: trend signals decay fastest in chaotic high-vol regimes (Carver's forecast scaling; Daniel & Moskowitz 2016 momentum crashes). Only take the crossover when realized vol sits in the calm half of its distribution.",
    longEntry: and(
      lt(pctrank(stdev(c, P("volN")), k(200)), P("volTh")),
      crossover(ema(c, P("fast")), ema(c, P("slow"))),
    ),
    longExit: crossunder(ema(c, P("fast")), ema(c, P("slow"))),
    params: { fast: p(10, 30, 20), slow: p(60, 200, 100), volN: p(30, 80, 50), volTh: { min: 0.3, max: 0.8, default: 0.6 } },
    risk: TREND_RISK,
  },
  // ------------------------------------------------------------- BREAKOUT
  {
    name: "seed_keltner_breakout",
    hypothesis: "Keltner channel breakout (Keltner 1960; Linda Raschke's adaptation): a close beyond EMA + k·ATR is a statistically abnormal excursion that marks initiative flow; channel midline exit keeps losses small. Best performer in the predecessor's library (ETH 1h).",
    longEntry: gt(c, add(ema(c, P("emaN")), mul(P("mult"), atr(P("atrN"))))),
    longExit: lt(c, ema(c, P("emaN"))),
    shortEntry: lt(c, sub(ema(c, P("emaN")), mul(P("mult"), atr(P("atrN"))))),
    shortExit: gt(c, ema(c, P("emaN"))),
    params: { emaN: p(14, 40, 20), atrN: p(10, 30, 20), mult: { min: 1, max: 3.5, default: 2 } },
    risk: BREAKOUT_RISK,
  },
  {
    name: "seed_bb_squeeze_breakout",
    hypothesis: "Volatility compression precedes expansion (Bollinger 'On Bollinger Bands'; Carter's TTM squeeze): when bandwidth sits in its bottom quartile and price then takes out the recent high, the expansion phase tends to run. Squeeze measured causally via stdev pctrank.",
    longEntry: and(
      lt(lag(pctrank(stdev(c, P("bbN")), k(150)), 1), P("squeezeTh")),
      gt(c, lag(highest(h, P("brkN")), 1)),
    ),
    longExit: lt(c, sma(c, P("bbN"))),
    params: { bbN: p(14, 40, 20), brkN: p(10, 40, 20), squeezeTh: { min: 0.1, max: 0.45, default: 0.25 } },
    risk: BREAKOUT_RISK,
  },
  {
    name: "seed_dual_thrust",
    hypothesis: "Dual Thrust (Michael Chalek): yesterday's true range defines today's noise band around the open; clearing open + k·range means directional flow has beaten mean-reverting noise. A classic futures-desk system, applied to hourly perps.",
    longEntry: gt(c, add(open, mul(P("kUp"), lag(max2(sub(highest(h, P("rangeN")), lowest(c, P("rangeN"))), sub(highest(c, P("rangeN")), lowest(l, P("rangeN")))), 1)))),
    longExit: lt(c, sma(c, P("exitN"))),
    shortEntry: lt(c, sub(open, mul(P("kUp"), lag(max2(sub(highest(h, P("rangeN")), lowest(c, P("rangeN"))), sub(highest(c, P("rangeN")), lowest(l, P("rangeN")))), 1)))),
    shortExit: gt(c, sma(c, P("exitN"))),
    params: { rangeN: p(10, 60, 24), kUp: { min: 0.3, max: 1.2, default: 0.6 }, exitN: p(10, 60, 24) },
    risk: BREAKOUT_RISK,
  },
  {
    name: "seed_compression_expansion",
    hypothesis: "Range-ratio compression (NR7 lineage, Crabel 'Day Trading with Short Term Price Patterns'): when short-horizon vol collapses versus its long-horizon baseline, the subsequent directional break carries information; ride it with a trailing stop.",
    longEntry: and(
      lt(div(stdev(c, P("shortN")), stdev(c, P("longN"))), P("ratioTh")),
      gt(c, lag(highest(h, P("shortN")), 1)),
    ),
    longExit: lt(c, ema(c, P("longN"))),
    params: { shortN: p(6, 24, 12), longN: p(60, 200, 100), ratioTh: { min: 0.4, max: 0.9, default: 0.65 } },
    risk: BREAKOUT_RISK,
  },
  // ------------------------------------------------------------- MEAN REVERSION
  {
    name: "seed_connors_rsi2",
    hypothesis: "RSI(2) pullback (Connors & Alvarez 'Short Term Trading Strategies That Work'): extreme short-term oversold readings inside a long-term uptrend mark liquidity-driven dips that snap back. Long-only by construction — shorting oversold dips in downtrends has no edge.",
    longEntry: and(gt(c, sma(c, P("regime"))), lt(rsi(c, k(2)), P("entryTh"))),
    longExit: gt(rsi(c, k(2)), P("exitTh")),
    params: { regime: p(120, 400, 200), entryTh: p(3, 20, 10), exitTh: p(50, 85, 65) },
    risk: MEANREV_RISK,
  },
  {
    name: "seed_bollinger_meanrev",
    hypothesis: "Band-extreme reversion with regime gate (Bollinger; Avellaneda-style stat-arb intuition): z-score extremes against the prevailing regime direction are mostly noise shocks that revert to the mean; trading only WITH the slow regime avoids catching knives.",
    longEntry: and(lt(zscore(c, P("zN")), { op: "neg", a: P("zTh") }), gt(c, sma(c, P("regime")))),
    longExit: gt(zscore(c, P("zN")), k(0)),
    shortEntry: and(gt(zscore(c, P("zN")), P("zTh")), lt(c, sma(c, P("regime")))),
    shortExit: lt(zscore(c, P("zN")), k(0)),
    params: { zN: p(20, 80, 40), zTh: { min: 1.2, max: 3, default: 2 }, regime: p(150, 450, 300) },
    risk: MEANREV_RISK,
  },
  {
    name: "seed_ibs_reversion",
    hypothesis: "Internal Bar Strength reversion (Pagonidis; documented on index ETFs): a close pinned to the bar's low (IBS near 0) inside an uptrend reflects intrabar liquidation that mean-reverts next bars; exit when the close pins the high.",
    longEntry: and(
      lt(div(sub(c, l), max2(sub(h, l), k(1e-9))), P("lowTh")),
      gt(c, sma(c, P("regime"))),
    ),
    longExit: gt(div(sub(c, l), max2(sub(h, l), k(1e-9))), P("highTh")),
    params: { lowTh: { min: 0.05, max: 0.3, default: 0.15 }, highTh: { min: 0.7, max: 0.95, default: 0.8 }, regime: p(120, 400, 200) },
    risk: MEANREV_RISK,
  },
  {
    name: "seed_keltner_reversion",
    hypothesis: "Channel-tag reversion in calm regimes (Raschke's 'Keltner fade'): tagging the lower Keltner band while volatility is NOT elevated is an overshoot of noise, not the start of a crash; midline exit. Vol-percentile gate is the crash guard.",
    longEntry: and(
      lt(c, sub(ema(c, P("emaN")), mul(P("mult"), atr(P("emaN"))))),
      lt(pctrank(atr(k(14)), k(150)), P("volTh")),
    ),
    longExit: gt(c, ema(c, P("emaN"))),
    params: { emaN: p(14, 40, 20), mult: { min: 1, max: 3, default: 2 }, volTh: { min: 0.4, max: 0.9, default: 0.7 } },
    risk: MEANREV_RISK,
  },
  // ------------------------------------------------------------- FUNDING / CARRY
  {
    name: "seed_funding_carry_contrarian",
    hypothesis: "Perp funding extremes are paid crowding signals (Koijen et al. 'Carry'; crypto-native: extreme negative funding = crowded shorts paying you to take the squeeze side, and liquidation cascades resolve against the crowd). Enter against extreme funding, collect the carry, exit when funding normalizes.",
    longEntry: lt({ op: "funding" }, { op: "neg", a: P("fundTh") }),
    longExit: gt({ op: "funding" }, k(0)),
    shortEntry: gt({ op: "funding" }, P("fundTh")),
    shortExit: lt({ op: "funding" }, k(0)),
    params: { fundTh: { min: 0.0001, max: 0.001, default: 0.0004 } },
    risk: { volTargetAnnual: 0.25, maxLeverage: 2, stopAtrMult: 3 },
  },
  {
    name: "seed_funding_gated_trend",
    hypothesis: "Trend entries gated by funding crowding: a breakout that the whole market is already long (high positive funding) has weak forward returns (late-crowd entries fuel liquidation cascades). Only take trend signals while funding shows the trade is NOT crowded.",
    longEntry: and(crossover(ema(c, P("fast")), ema(c, P("slow"))), lt({ op: "funding" }, P("crowdTh"))),
    longExit: crossunder(ema(c, P("fast")), ema(c, P("slow"))),
    params: { fast: p(10, 30, 16), slow: p(50, 160, 80), crowdTh: { min: 0.0001, max: 0.0008, default: 0.0003 } },
    risk: TREND_RISK,
  },
  {
    name: "seed_zscore_vwapless_fade",
    hypothesis: "Short-horizon overreaction fade (Lehmann 1990 reversal; crypto microstructure: liquidation cascades overshoot): a >2σ one-bar return against an otherwise flat regime partially retraces as market makers replenish. Tight stop — when it's wrong it's a regime break.",
    longEntry: and(lt(zscore(roc(c, k(1)), P("zN")), { op: "neg", a: P("zTh") }), lt({ op: "abs", a: { op: "slope", src: c, period: P("slopeN") } }, P("flatTh"))),
    longExit: gt(zscore(roc(c, k(1)), P("zN")), k(0)),
    params: { zN: p(50, 200, 100), zTh: { min: 1.5, max: 3.5, default: 2.2 }, slopeN: p(50, 200, 100), flatTh: { min: 0.0001, max: 0.002, default: 0.0006, int: false } },
    risk: { volTargetAnnual: 0.2, maxLeverage: 1.5, stopAtrMult: 2 },
  },
];

// quick structural self-check used by the smoke test
export function libraryNames(): string[] {
  return SEED_LIBRARY.map((s) => s.name);
}
