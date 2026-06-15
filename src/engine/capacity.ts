// Capacity & market-impact model (Wave-2 shadow rigor). SHADOW-ONLY: computes
// an AUM-dependent net Sharpe curve on top of a frictionless/base backtest and
// reports the AUM where the strategy still clears a Sharpe floor. NOTHING here
// changes the base backtest costs or any gauntlet pass/fail.
//
// Impact model (square-root / Almgren-style):
//   participation_t = orderNotional_t / ADV_notional_t
//   impactCostRate_t (per unit traded) = k * sigma_bar_t * sqrt(participation_t)
//   per-bar return drag = turnover_t * impactCostRate_t
// where
//   orderNotional_t  = turnover_t * AUM           (turnover = |w_t - w_{t-1}|)
//   ADV_notional_t   = rolling-mean( bar baseVolume * close )   [the ADV proxy]
//   sigma_bar_t      = trailing per-bar return stdev (the bar's own vol scale)
//
// The base backtest already charges fees + a fixed half-spread/slip (SLIP_BPS).
// This layer adds ONLY the size-dependent component, so at AUM->0 the impact
// drag -> 0 and the result equals the frictionless (base) backtest.

import { runBacktest } from "./backtest";
import type { BacktestOpts, Bars, StrategyDoc } from "./types";

export interface CapacityCfg {
  /** impact coefficient k in cost = k * sigma * sqrt(participation). ~0.5-1.0 */
  k?: number;
  /** rolling window (bars) for the ADV notional proxy (default 720 ~ 30d @1h) */
  advWindow?: number;
  /** trailing window (bars) for per-bar sigma (default 96) */
  volWindow?: number;
  /** AUM grid (USD) to evaluate the capacity curve over */
  aumGrid?: number[];
  /**
   * Net-Sharpe floor defining capacity. Capacity = max AUM whose net Sharpe is
   * >= max(capFloorAbs, capFloorFrac * frictionlessSharpe). Defaults: keep >=50%
   * of frictionless OR >= 0.5 absolute, whichever is HIGHER (a real floor).
   */
  capFloorFrac?: number;
  capFloorAbs?: number;
  /** reference AUM for impactAdjustedSharpe (default $100k) */
  refAumUsd?: number;
}

export const DEFAULT_AUM_GRID = [
  1e4, 2.5e4, 5e4, 1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6, 1e7, 2.5e7, 5e7, 1e8,
];

export interface CapacityPoint { aumUsd: number; netSharpe: number; impactDragAnnual: number; meanParticipation: number }

export interface CapacityResult {
  /** frictionless (base) annualized Sharpe — the AUM->0 limit */
  frictionlessSharpe: number;
  /** net Sharpe at the reference AUM (default $100k) */
  impactAdjustedSharpe: number;
  refAumUsd: number;
  /** max AUM (USD) where net Sharpe >= floor; 0 if even the smallest grid AUM fails */
  capacityUsd: number;
  /** the Sharpe floor actually used */
  floor: number;
  /** full curve (sorted ascending by AUM) */
  curve: CapacityPoint[];
  /** turnover/year of the deployed params (impact scales with this) */
  turnoverPerYear: number;
  /** mean ADV notional proxy over the evaluated range (USD) */
  meanAdvNotionalUsd: number;
  note?: string;
}

// trailing per-bar return stdev (population), causal, NaN during warmup.
function trailingSigma(c: number[], window: number, from: number, to: number): Float64Array {
  const n = c.length;
  const sig = new Float64Array(n).fill(NaN);
  let s = 0, sq = 0, cnt = 0;
  const r = new Float64Array(n);
  for (let i = 1; i < n; i++) r[i] = c[i - 1] > 0 ? c[i] / c[i - 1] - 1 : 0;
  for (let i = Math.max(1, from); i <= to; i++) {
    s += r[i]; sq += r[i] * r[i]; cnt++;
    if (cnt > window) { const o = r[i - window]; s -= o; sq -= o * o; cnt--; }
    if (cnt >= Math.max(5, Math.floor(window / 2))) {
      const mean = s / cnt;
      sig[i] = Math.sqrt(Math.max(0, sq / cnt - mean * mean));
    }
  }
  return sig;
}

// rolling-mean ADV notional proxy: mean over `window` bars of (baseVolume*close).
function trailingAdvNotional(bars: Bars, window: number, from: number, to: number): Float64Array {
  const n = bars.c.length;
  const adv = new Float64Array(n).fill(NaN);
  let s = 0, cnt = 0;
  const notional = (i: number) => Math.max(0, bars.v[i]) * Math.max(0, bars.c[i]);
  for (let i = Math.max(0, from); i <= to; i++) {
    s += notional(i); cnt++;
    if (cnt > window) { s -= notional(i - window); cnt--; }
    if (cnt >= Math.max(5, Math.floor(window / 4))) adv[i] = s / cnt;
  }
  return adv;
}

/**
 * Compute the capacity curve + scalar metrics for a strategy at fixed deployment
 * params. Runs ONE base backtest (for weights/turnover/returns), then for each
 * AUM applies the square-root impact drag analytically per bar — no extra
 * backtests, so it is cheap.
 */
export function computeCapacity(
  doc: StrategyDoc,
  bars: Bars,
  params: Record<string, number>,
  opts: BacktestOpts,
  range: { startI: number; endI: number },
  cfg: CapacityCfg = {},
): CapacityResult {
  const k = cfg.k ?? 0.7;
  const advWindow = cfg.advWindow ?? 720;
  const volWindow = cfg.volWindow ?? 96;
  const aumGrid = (cfg.aumGrid ?? DEFAULT_AUM_GRID).slice().sort((a, b) => a - b);
  const refAum = cfg.refAumUsd ?? 1e5;
  const ppy = opts.ppy;

  const from = Math.max(1, range.startI);
  const to = Math.min(bars.c.length - 1, range.endI);

  // base (frictionless-of-size) backtest: weights + net-of-fixed-cost returns
  const base = runBacktest(doc, bars, params, opts, { startI: from, endI: to });
  const w = base.weights;
  const baseRet = base.ret;

  const sigma = trailingSigma(bars.c, volWindow, from, to);
  const adv = trailingAdvNotional(bars, advWindow, from, to);

  // frictionless Sharpe (base costs only, no impact)
  const frictionlessSharpe = sharpeOf(baseRet, from + 1, to, ppy);

  // per-bar turnover and the size-independent impact "unit" u_t such that
  //   impactDrag_t(AUM) = turnover_t * k * sigma_t * sqrt( turnover_t*AUM / ADV_t )
  // We precompute per bar: turnover_t, sigma_t, ADV_t. Missing sigma/ADV -> 0 drag.
  const idx: number[] = [];
  const turnover: number[] = [];
  const sig: number[] = [];
  const advN: number[] = [];
  let advSum = 0, advCnt = 0;
  for (let i = from + 1; i <= to; i++) {
    const tov = Math.abs(w[i - 1] - (i - 2 >= from - 1 ? w[i - 2] : 0));
    idx.push(i);
    turnover.push(tov);
    sig.push(Number.isFinite(sigma[i]) ? sigma[i] : 0);
    const a = Number.isFinite(adv[i]) ? adv[i] : NaN;
    advN.push(a);
    if (Number.isFinite(a) && a > 0) { advSum += a; advCnt++; }
  }
  const meanAdv = advCnt ? advSum / advCnt : 0;

  const evalAum = (aum: number): CapacityPoint => {
    const net = new Float64Array(to + 1);
    let dragSum = 0, partSum = 0, partCnt = 0;
    for (let m = 0; m < idx.length; m++) {
      const i = idx[m];
      const tov = turnover[m];
      let drag = 0;
      if (tov > 0 && sig[m] > 0 && Number.isFinite(advN[m]) && (advN[m] as number) > 0) {
        const orderNotional = tov * aum;
        const participation = orderNotional / (advN[m] as number);
        drag = tov * k * sig[m] * Math.sqrt(participation);
        partSum += participation; partCnt++;
      }
      dragSum += drag;
      net[i] = baseRet[i] - drag;
    }
    const netSharpe = sharpeOf(net, from + 1, to, ppy);
    const years = (to - from) / ppy;
    const impactDragAnnual = years > 0 ? dragSum / years : dragSum;
    return { aumUsd: aum, netSharpe, impactDragAnnual, meanParticipation: partCnt ? partSum / partCnt : 0 };
  };

  const curve = aumGrid.map(evalAum);

  // capacity floor: max( capFloorAbs , capFloorFrac * frictionless )
  const floorFrac = cfg.capFloorFrac ?? 0.5;
  const floorAbs = cfg.capFloorAbs ?? 0.5;
  const floor = Math.max(floorAbs, floorFrac * frictionlessSharpe);

  // capacity = the LARGEST AUM whose net Sharpe is still >= floor, walking the
  // sorted grid from the bottom and stopping at the first breach (net Sharpe is
  // monotonically non-increasing in AUM, so this is the capacity frontier).
  let capacityUsd = 0;
  for (const p of curve) {
    if (p.netSharpe >= floor) capacityUsd = p.aumUsd;
    else break;
  }

  const impactAdjustedSharpe = evalAum(refAum).netSharpe;

  return {
    frictionlessSharpe,
    impactAdjustedSharpe,
    refAumUsd: refAum,
    capacityUsd,
    floor,
    curve,
    turnoverPerYear: base.metrics.turnoverPerYear,
    meanAdvNotionalUsd: meanAdv,
    note: meanAdv <= 0 ? "no ADV proxy (zero/absent bar volume) — impact disabled" : undefined,
  };
}

function sharpeOf(ret: Float64Array | number[], from: number, to: number, ppy: number): number {
  const n = to - from + 1;
  if (n < 2) return 0;
  let s = 0, sq = 0;
  for (let i = from; i <= to; i++) { const r = Number(ret[i]); s += r; sq += r * r; }
  const mean = s / n;
  const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
  return sd > 1e-15 ? (mean / sd) * Math.sqrt(ppy) : 0;
}
