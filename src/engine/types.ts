// Core types for the finance-engine-v2 strategy engine.
// A strategy is DATA (a JSON expression graph), never code.

export type PriceField = "open" | "high" | "low" | "close" | "volume";

export type IndicatorOp =
  | "ema" | "sma" | "wma" | "rsi" | "atr" | "stdev" | "highest" | "lowest"
  | "lag" | "zscore" | "slope" | "pctrank" | "median" | "roc";

export type BinaryOp = "add" | "sub" | "mul" | "div" | "min2" | "max2";
export type UnaryOp = "abs" | "neg" | "log" | "sign" | "sqrt";
export type CompareOp = "gt" | "lt" | "crossover" | "crossunder";
export type LogicOp = "and" | "or";

export type Expr =
  | { op: "price"; field: PriceField }
  | { op: "funding" } // last-known perp funding rate per bar (carry/crowding signal)
  // ---- WAVE-3a crypto-native inputs (forward-filled per bar; 0 before first stamp) ----
  | { op: "fundroc" }   // funding rate-of-change vs the previous funding stamp (per-bar, last-known)
  | { op: "fundzscore" }// funding z-score over a trailing window of funding stamps (crowding extremity)
  | { op: "fundaccel" } // funding acceleration: change in fundroc (2nd difference of funding stamps)
  | { op: "fundmom" }   // cumulative funding over a trailing window (carry momentum / paid-to-hold pressure)
  | { op: "basis" }     // perp-spot basis (perpClose-spotClose)/spotClose — crypto carry signal
  | { op: "oi" }        // open interest (base units), last-known per bar
  | { op: "lsr" }       // taker long/short volume ratio, last-known per bar (positioning)
  | { op: "hourutc" } // bar-open hour in UTC, 0-23 (intraday seasonality)
  | { op: "dowutc" }  // bar-open day of week UTC, 0=Sun..6=Sat (calendar seasonality)
  | { op: "const"; value: number }
  | { op: "param"; name: string }
  | { op: IndicatorOp; src: Expr; period: Expr }
  | { op: BinaryOp; a: Expr; b: Expr }
  | { op: UnaryOp; a: Expr }
  | { op: CompareOp; a: Expr; b: Expr }
  | { op: LogicOp; a: Expr; b: Expr }
  | { op: "not"; a: Expr };

export interface ParamSpec {
  min: number;
  max: number;
  default: number;
  int?: boolean;
}

export interface RiskSpec {
  /** ATR-multiple hard stop from entry (omit = none) */
  stopAtrMult?: number;
  /** ATR-multiple trailing stop (omit = none) */
  trailAtrMult?: number;
  /** Annualized volatility target, e.g. 0.25 */
  volTargetAnnual: number;
  /** Max absolute weight (leverage) */
  maxLeverage: number;
}

export interface StrategyDoc {
  name: string;
  /** WHY this should work — required from every generator (LLM or GP). */
  hypothesis: string;
  /** bar timeframe this strategy trades (default "1h"); floors scale with it */
  tf?: "1h" | "4h" | "1d";
  longEntry: Expr;
  longExit: Expr;
  shortEntry?: Expr;
  shortExit?: Expr;
  params: Record<string, ParamSpec>;
  risk: RiskSpec;
}

/** Columnar OHLCV + funding, the on-disk/R2 format. Timestamps ms UTC, bar OPEN time. */
export interface Bars {
  symbol: string;
  tf: string;
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
  /** funding timestamps (ms) and rates, 8h cadence; optional */
  fundingT?: number[];
  fundingR?: number[];
  // ---- WAVE-3a crypto-native series (ADDITIVE; all optional, backward-compatible) ----
  /** SPOT close aligned bar-for-bar with t (for perp-spot basis). Same length as t when present. */
  spotC?: number[];
  /** open-interest stamps (ms) + value (base units), ~5min cadence from the metrics archive */
  oiT?: number[];
  oiV?: number[];
  /** taker long/short volume ratio stamps (ms) + ratio, ~5min cadence from the metrics archive */
  lsrT?: number[];
  lsrR?: number[];
}

export interface CostModel {
  feeBps: number;   // taker fee per side
  slipBps: number;  // expected slippage per side (half-spread + impact)
}

export interface BacktestOpts {
  cost: CostModel;
  /** bars per year for annualization (1h=8760, 4h=2190, 1d=365) */
  ppy: number;
  startEquity?: number;
  /** multiply slippage (stress ramps) */
  slipMult?: number;
}

export interface Trade {
  entryI: number;
  exitI: number;
  dir: 1 | -1;
  entryTs: number;
  exitTs: number;
  ret: number; // compounded strategy return over the trade
}

export interface Metrics {
  bars: number;
  totalReturn: number;
  cagr: number;
  sharpe: number;
  sortino: number;
  maxDD: number;
  calmar: number;
  trades: number;
  winRate: number;
  avgTradeRet: number;
  exposure: number; // fraction of bars with nonzero weight
  turnoverPerYear: number;
  monthlyReturns: { ym: string; ret: number }[];
}

export interface BacktestResult {
  /** per-bar strategy returns (net of costs+funding) */
  ret: Float64Array;
  equity: Float64Array;
  weights: Float64Array;
  metrics: Metrics;
  trades: Trade[];
}

export interface GateFloors {
  trainMinSharpe: number;        // 0.8
  trainMinTradesPerYear: number; // 30
  trainMaxDD: number;            // -0.35
  // S3 single-symbol floors are a SCREEN (cut obvious junk cheaply);
  // the BINDING floors live at the deployed-portfolio level (S4).
  wfMinMeanSharpe: number;       // 0.2  screen
  wfMinPctPositive: number;      // 0.40 screen
  wfWorstMonth: number;          // -0.22 screen
  wfMaxDD: number;               // -0.35 screen
  crossSymbolMinPositive: number;// 3 (of universe)
  portMinSharpe: number;         // 0.7  (deployed equal-weight portfolio, all OOS)
  portMinPctPositive: number;    // 0.55 (portfolio monthly consistency — deployment level)
  portWorstMonth: number;        // -0.12 (portfolio worst month — deployment level)
  minDSR: number;                // 0.95
  maxPermutationP: number;       // 0.05
  stressSlipMultSurvive: number; // 3 (sharpe@3x > 50% base)
  stressCrisisMaxDD: number;     // -0.40
  sealedMinSharpe: number;       // 0.5
  sealedMaxDD: number;           // -0.30
  sealedMinTrades: number;       // 10
  incubationDays: number;        // 30
  championBeatRatio: number;     // 1.1
}

export const DEFAULT_FLOORS: GateFloors = {
  trainMinSharpe: 0.8,
  trainMinTradesPerYear: 30,
  trainMaxDD: -0.35,
  wfMinMeanSharpe: 0.2,
  wfMinPctPositive: 0.4,
  wfWorstMonth: -0.22,
  wfMaxDD: -0.35,
  crossSymbolMinPositive: 3,
  portMinSharpe: 0.7,
  portMinPctPositive: 0.55,
  portWorstMonth: -0.12,
  minDSR: 0.95,
  maxPermutationP: 0.05,
  stressSlipMultSurvive: 3,
  stressCrisisMaxDD: -0.4,
  sealedMinSharpe: 0.5,
  sealedMaxDD: -0.3,
  sealedMinTrades: 10,
  incubationDays: 30,
  championBeatRatio: 1.1,
};

export const PPY: Record<string, number> = { "5m": 105120, "15m": 35040, "1h": 8760, "4h": 2190, "1d": 365 };

/** per-symbol half-spread+impact estimate in bps (perp books, retail size) */
export const SLIP_BPS: Record<string, number> = {
  "BTC/USDT": 1.5, "ETH/USDT": 2, "SOL/USDT": 3, "BNB/USDT": 3.5, "XRP/USDT": 4,
};
export const DEFAULT_FEE_BPS = 5; // Binance USDT-M taker 0.05% (no VIP)

export const COMPLEXITY_LIMITS = { maxNodes: 48, maxDepth: 10, maxParams: 6, maxPeriod: 500 };

export const VALID_TFS = new Set(["1h", "4h", "1d"]);

/** floor scaling for slower timeframes (trade-count floors etc.) */
export function tfScale(tf: string | undefined): number {
  return tf === "4h" ? 0.6 : tf === "1d" ? 0.35 : 1;
}
