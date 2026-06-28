// Normalized indicator payload for the live Watch tab. Every strategy family maps
// its native decision logic into the SAME shape — a daily candle series, optional
// price overlays (moving averages), and stacked indicator panes each carrying the
// exact trigger thresholds the strategy fires on — so the /watch UI can render any
// strategy generically and honestly show "the indicators it uses + the lines where
// it would trade". Computed point-in-time (the underlying engine fns are lagged).
//
// Heavy data (R2 bars + on-chain) is loaded by the indicators Trigger task, which
// then calls the builder here and persists the result to Convex; the page reads it
// reactively. Keep this module PURE (no IO) so it runs anywhere.

import type { Bars } from "./types";
import { isBlendSleeve, blendTrack, type BlendSleeveDoc } from "./blendsleeve";

export interface IndPoint { t: number; v: number }
export interface OHLC { t: number; o: number; h: number; l: number; c: number }
export interface ThresholdLine { label: string; value: number; kind: "buy" | "sell" | "neutral" }
export interface PriceOverlay { id: string; label: string; color: string; series: IndPoint[] }
export interface IndicatorPane {
  id: string;
  label: string;
  unit?: string;             // "" | "%" | "x"
  series: IndPoint[];        // the primary indicator line
  thresholds: ThresholdLine[];
  current: number | null;
  hint?: string;             // one-line plain-English meaning
  fill01?: boolean;          // render as a 0..1 area (exposure / weight track)
}
export interface StrategyIndicators {
  symbol: string;
  tf: string;
  asOf: number;
  candles: OHLC[];
  overlays: PriceOverlay[];  // drawn ON the price chart (moving averages, bands)
  panes: IndicatorPane[];    // stacked below the price chart
  weightTrack: IndPoint[];   // combined target exposure 0..1 over time
  logic: string;             // human-readable description of the trigger rules
}

// amber (trend/200d), blue (fast/trend SMA), green up, red down
const C_MA = "#f5b932", C_SMA = "#5cc8ff";
const MAX_PTS = 800; // ~2.2y of daily bars — enough cycle context for the trigger lines

function lastN<T>(a: T[], n: number): T[] { return a.length > n ? a.slice(a.length - n) : a; }

/** Build a timestamp -> OHLC map from raw bars (exact alignment with engine series). */
function ohlcMap(bars: Bars): Map<number, OHLC> {
  const m = new Map<number, OHLC>();
  for (let i = 0; i < bars.t.length; i++) m.set(bars.t[i], { t: bars.t[i], o: bars.o[i], h: bars.h[i], l: bars.l[i], c: bars.c[i] });
  return m;
}

/**
 * BLEND (the 70/30 on-chain + trend strat): the rich view. NUPL pane with its buy
 * (≤ nuplBuy) and sell (≥ nuplSell) trigger lines, the 200d MA + trend SMA overlaid
 * on price (the two trend confirms), and the combined target-weight ramp.
 */
function blendIndicators(doc: BlendSleeveDoc, bars: Bars): StrategyIndicators {
  const track = lastN(blendTrack(doc, bars), MAX_PTS);
  const om = ohlcMap(bars);
  const candles: OHLC[] = [];
  const ma: IndPoint[] = [], sma: IndPoint[] = [], nupl: IndPoint[] = [], weight: IndPoint[] = [];
  for (const p of track) {
    const c = om.get(p.t) ?? { t: p.t, o: p.close, h: p.close, l: p.close, c: p.close };
    candles.push(c);
    ma.push({ t: p.t, v: p.ma });
    sma.push({ t: p.t, v: p.sma });
    nupl.push({ t: p.t, v: p.nupl });
    weight.push({ t: p.t, v: p.weight });
  }
  const last = track[track.length - 1];
  return {
    symbol: doc.symbol, tf: "1d", asOf: last?.t ?? 0, candles,
    overlays: [
      { id: "ma200", label: `${doc.maWin}d MA`, color: C_MA, series: ma },
      { id: "sma", label: `SMA ${doc.smaWin}`, color: C_SMA, series: sma },
    ],
    panes: [
      {
        id: "nupl", label: "NUPL · on-chain valuation", unit: "",
        series: nupl, current: last ? last.nupl : null,
        thresholds: [
          { label: `buy ≤ ${doc.nuplBuy}`, value: doc.nuplBuy, kind: "buy" },
          { label: `sell ≥ ${doc.nuplSell}`, value: doc.nuplSell, kind: "sell" },
        ],
        hint: "1 − 1/MVRV. Accumulate in capitulation (low), distribute into euphoria (high).",
      },
      {
        id: "weight", label: "target exposure", unit: "", fill01: true,
        series: weight, current: last ? last.weight : null,
        thresholds: [{ label: "fully long", value: 1, kind: "neutral" }],
        hint: "Combined 70% on-chain leg + 30% trend leg. 0 = cash, 1 = fully long.",
      },
    ],
    weightTrack: weight,
    logic: `Buy (DCA in) when NUPL ≤ ${doc.nuplBuy} and price reclaims its ${doc.maWin}d MA; sell (DCA out) into euphoria when NUPL ≥ ${doc.nuplSell}; the 30% trend leg is long while close > SMA ${doc.smaWin}.`,
  };
}

/** Plain SMA of the last `win` closes ending at index i (point-in-time). */
function smaSeries(close: number[], win: number): number[] {
  const out = new Array<number>(close.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < close.length; i++) { s += close[i]; if (i >= win) s -= close[i - win]; if (i >= win - 1) out[i] = s / win; }
  return out;
}

/**
 * Generic trend-SMA view used for trend-beta sleeves and as the fallback for any
 * single-coin long-flat strategy: price + its trend SMA overlay, and a binary
 * long/flat exposure track. The strategy is long while close > SMA(win).
 */
function trendIndicators(symbol: string, win: number, bars: Bars): StrategyIndicators {
  const smaFull = smaSeries(bars.c, win);
  const start = Math.max(0, bars.t.length - MAX_PTS);
  const candles: OHLC[] = [], sma: IndPoint[] = [], weight: IndPoint[] = [];
  for (let i = start; i < bars.t.length; i++) {
    candles.push({ t: bars.t[i], o: bars.o[i], h: bars.h[i], l: bars.l[i], c: bars.c[i] });
    if (Number.isFinite(smaFull[i])) sma.push({ t: bars.t[i], v: smaFull[i] });
    weight.push({ t: bars.t[i], v: Number.isFinite(smaFull[i]) && bars.c[i] >= smaFull[i] ? 1 : 0 });
  }
  const li = bars.t.length - 1;
  const longNow = Number.isFinite(smaFull[li]) && bars.c[li] >= smaFull[li];
  return {
    symbol, tf: "1d", asOf: bars.t[li] ?? 0, candles,
    overlays: [{ id: "sma", label: `SMA ${win}`, color: C_SMA, series: sma }],
    panes: [{
      id: "weight", label: "long / flat", unit: "", fill01: true, series: weight,
      current: longNow ? 1 : 0, thresholds: [{ label: "long", value: 1, kind: "buy" }],
      hint: `Long while price is above its ${win}-day average, flat below it.`,
    }],
    weightTrack: weight,
    logic: `Long when close > SMA ${win}; flat otherwise.`,
  };
}

/** Price-only fallback for kinds without a bespoke indicator view yet. */
function priceOnly(symbol: string, bars: Bars, logic: string): StrategyIndicators {
  const start = Math.max(0, bars.t.length - MAX_PTS);
  const candles: OHLC[] = [];
  for (let i = start; i < bars.t.length; i++) candles.push({ t: bars.t[i], o: bars.o[i], h: bars.h[i], l: bars.l[i], c: bars.c[i] });
  return { symbol, tf: "1d", asOf: bars.t[bars.t.length - 1] ?? 0, candles, overlays: [], panes: [], weightTrack: [], logic };
}

/**
 * Map any strategy doc + its (already-loaded, on-chain-attached where needed) daily
 * bars into the normalized indicator payload the Watch tab renders.
 */
export function buildStrategyIndicators(rawDoc: unknown, bars: Bars): StrategyIndicators {
  if (isBlendSleeve(rawDoc)) return blendIndicators(rawDoc, bars);
  const d = (rawDoc ?? {}) as { kind?: string; symbol?: string; smaWin?: number };
  const symbol = d.symbol ?? bars.symbol;
  if (d.kind === "trendbeta" && typeof d.smaWin === "number") return trendIndicators(symbol, Math.max(20, Math.round(d.smaWin)), bars);
  return priceOnly(symbol, bars, `Strategy kind "${d.kind ?? "dsl"}" — live price with trade markers. Indicator overlay for this family is coming.`);
}
