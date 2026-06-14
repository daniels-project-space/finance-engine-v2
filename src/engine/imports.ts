// Strategies imported from published, citable sources — rules translated
// faithfully into the DSL, source URL in every hypothesis. They get no
// special treatment: same gauntlet, same floors. If they out-rank the
// home-grown pool, the breeder and the Opus lane inherit them automatically
// (parents come from the tournament board; lessons cite their mechanisms).

import type { Expr, ParamSpec, StrategyDoc } from "./types";

const c: Expr = { op: "price", field: "close" };
const h: Expr = { op: "price", field: "high" };
const l: Expr = { op: "price", field: "low" };
const open: Expr = { op: "price", field: "open" };
const hour: Expr = { op: "hourutc" };
const dow: Expr = { op: "dowutc" };
const k = (value: number): Expr => ({ op: "const", value });
const P = (name: string): Expr => ({ op: "param", name });
const ema = (src: Expr, period: Expr): Expr => ({ op: "ema", src, period });
const sma = (src: Expr, period: Expr): Expr => ({ op: "sma", src, period });
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
const gt = (a: Expr, b: Expr): Expr => ({ op: "gt", a, b });
const lt = (a: Expr, b: Expr): Expr => ({ op: "lt", a, b });
const crossunder = (a: Expr, b: Expr): Expr => ({ op: "crossunder", a, b });
const and = (a: Expr, b: Expr): Expr => ({ op: "and", a, b });
const or = (a: Expr, b: Expr): Expr => ({ op: "or", a, b });

const p = (min: number, max: number, def: number, int = true): ParamSpec => ({ min, max, default: def, int });

export const IMPORTED_LIBRARY: StrategyDoc[] = [
  {
    name: "imp_connors_double7",
    hypothesis: "Connors Double 7 (Connors & Alvarez, 'Short Term Trading Strategies That Work'; documented Sharpe 1.4, 82.5% win on ETFs — quantifiedstrategies.com/larry-connors-double-seven-strategy-does-it-still-work): a close below the prior 7-day low inside a long-term uptrend is liquidity-driven panic that mean-reverts; exit at the 7-day high.",
    tf: "1d",
    longEntry: and(gt(c, sma(c, P("regime"))), lt(c, lag(lowest(c, P("lowN")), 1))),
    longExit: gt(c, lag(highest(c, P("highN")), 1)),
    params: { regime: p(120, 300, 200), lowN: p(4, 12, 7), highN: p(4, 12, 7) },
    risk: { volTargetAnnual: 0.25, maxLeverage: 2, stopAtrMult: 3 },
  },
  {
    name: "imp_btc_hour_seasonality",
    hypothesis: "Bitcoin intraday seasonality (Vojtko & Javorská, SSRN 4581124; quantpedia.com/the-seasonality-of-bitcoin): returns concentrate 21:00-23:00 UTC (US afternoon flows), worst hours 03:00-04:00. Long the documented window only — annualized 40.6%, Calmar 1.79 in the study. Pure calendar edge; no price signal.",
    tf: "1h",
    longEntry: and(gt(hour, P("startH")), lt(hour, P("endH"))),
    longExit: or(gt(hour, P("endH")), lt(hour, P("startH"))),
    params: { startH: { min: 17, max: 22, default: 20.5 }, endH: { min: 22, max: 23.8, default: 23.2 } },
    risk: { volTargetAnnual: 0.3, maxLeverage: 2 },
  },
  {
    name: "imp_clenow_breakout",
    hypothesis: "Clenow core trend model ('Following the Trend'; followingthetrend.com/the-trading-system/trading-system-rules): trade 50-day breakouts ONLY in the direction of the 50>100 SMA regime, ride with a 3-ATR trailing stop, ATR-scaled sizing. Whipsaw-filtered breakout following, the managed-futures workhorse.",
    tf: "1d",
    longEntry: and(gt(sma(c, P("fast")), sma(c, P("slow"))), gt(c, lag(highest(h, P("brkN")), 1))),
    longExit: crossunder(sma(c, P("fast")), sma(c, P("slow"))),
    shortEntry: and(lt(sma(c, P("fast")), sma(c, P("slow"))), lt(c, lag(lowest(l, P("brkN")), 1))),
    shortExit: { op: "crossover", a: sma(c, P("fast")), b: sma(c, P("slow")) },
    params: { fast: p(30, 70, 50), slow: p(80, 150, 100), brkN: p(30, 70, 50) },
    risk: { volTargetAnnual: 0.25, maxLeverage: 2, trailAtrMult: 3 },
  },
  {
    name: "imp_nr7_orb",
    hypothesis: "Crabel NR7 opening-range breakout ('Day Trading with Short-Term Price Patterns', 1990; quantifiedstrategies.com/nr7-trading-strategy-toby-crabel): the narrowest range of 7 days marks coiled positioning; a break of open + stretch resolves it directionally (60-76% win in Crabel's futures tests). Stretch proxied by ATR.",
    tf: "1d",
    longEntry: and(
      lt(lag(pctrank(sub(h, l), P("nrN")), 1), k(0.18)),
      gt(c, add(open, mul(P("stretch"), lag(atr(k(10)), 1)))),
    ),
    longExit: lt(c, sma(c, P("exitN"))),
    params: { nrN: p(5, 10, 7), stretch: { min: 0.2, max: 1, default: 0.5 }, exitN: p(5, 20, 10) },
    risk: { volTargetAnnual: 0.25, maxLeverage: 2, stopAtrMult: 2 },
  },
  {
    name: "imp_weekend_fade",
    hypothesis: "Crypto weekend liquidity effect (documented across the weekend-anomaly literature, e.g. quantpedia.com/are-there-seasonal-intraday-or-overnight-anomalies-in-bitcoin): thin Sat/Sun books overshoot on flow shocks and revert when depth returns. Fade 2σ weekend moves only.",
    tf: "1h",
    longEntry: and(
      lt(zscore(c, P("zN")), { op: "neg", a: P("zTh") }),
      or(gt(dow, k(5.5)), lt(dow, k(0.5))),
    ),
    longExit: gt(zscore(c, P("zN")), k(0)),
    params: { zN: p(24, 96, 48), zTh: { min: 1.5, max: 3, default: 2 } },
    risk: { volTargetAnnual: 0.2, maxLeverage: 1.5, stopAtrMult: 2.5 },
  },
  {
    name: "imp_momentum_acceleration",
    hypothesis: "Momentum acceleration (momentum-of-momentum; SSRN literature on 'momentum velocity' / Chen-Yu acceleration): when the fast trailing return exceeds the slow one AND the slow one is positive, the trend is young rather than exhausted — the phase where TSMOM earns most of its premium.",
    tf: "4h",
    longEntry: and(gt(roc(c, P("fastR")), roc(c, P("slowR"))), gt(roc(c, P("slowR")), k(0))),
    longExit: lt(roc(c, P("fastR")), k(0)),
    shortEntry: and(lt(roc(c, P("fastR")), roc(c, P("slowR"))), lt(roc(c, P("slowR")), k(0))),
    shortExit: gt(roc(c, P("fastR")), k(0)),
    params: { fastR: p(12, 60, 30), slowR: p(60, 240, 120) },
    risk: { volTargetAnnual: 0.25, maxLeverage: 2, trailAtrMult: 4 },
  },
  {
    name: "imp_trend_pullback_band",
    hypothesis: "Pullback-to-band in trend (the 'buy the dip in an uptrend' workhorse documented across quantifiedstrategies.com/trend-following-trading-strategy variants): in a regime uptrend, a tag of the EMA - k·ATR band is supply exhaustion, not reversal; re-entry to the mean pays. Tighter risk than breakout entries since entry price is favorable.",
    tf: "4h",
    longEntry: and(gt(c, sma(c, P("regime"))), lt(c, sub(ema(c, P("bandN")), mul(P("bandK"), atr(P("bandN")))))),
    longExit: gt(c, ema(c, P("bandN"))),
    params: { regime: p(100, 300, 180), bandN: p(12, 40, 20), bandK: { min: 0.5, max: 2.5, default: 1.2 } },
    risk: { volTargetAnnual: 0.25, maxLeverage: 2, stopAtrMult: 2.5 },
  },
  {
    name: "imp_bb_ride_expansion",
    hypothesis: "Band-ride with expanding volatility (Bollinger's 'walking the band' — bollingerbands.com canon; momentum continuation while %B>1 and bandwidth expands): closes outside the upper band during vol expansion are continuation, not reversal; exit when price loses the band midline.",
    tf: "4h",
    longEntry: and(
      gt(c, add(sma(c, P("bbN")), mul(k(2), stdev(c, P("bbN"))))),
      gt(stdev(c, P("bbN")), lag(stdev(c, P("bbN")), 5)),
    ),
    longExit: lt(c, sma(c, P("bbN"))),
    params: { bbN: p(14, 40, 20) },
    risk: { volTargetAnnual: 0.25, maxLeverage: 2, trailAtrMult: 3.5 },
  },
];
