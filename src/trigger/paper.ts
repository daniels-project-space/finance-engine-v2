// Live paper trading: hourly step for every incubating strategy + the champion.
// Pure simulation with realistic fills (slippage + fees + funding), designed so
// the fill function swaps for a real exchange connector (testnet, then live)
// without touching the accounting.

import { logger, schedules } from "@trigger.dev/sdk";
import { api, convex } from "../lib/convexClient";
import { mergeConfig } from "../lib/appConfig";
import { loadBars } from "../lib/data";
import { computeSignals, toArrays } from "../engine/compile";
import { DEFAULT_FEE_BPS, PPY, SLIP_BPS, type Bars, type StrategyDoc } from "../engine/types";
import { isIvSleeve, buildIvDaily, type IvSleeveDoc } from "../engine/ivsleeve";
import { isOcSleeve } from "../engine/onchainsleeve";
import { isXSection } from "../engine/xsection";
import { isTrendBeta, buildTrendDaily, type TrendBetaDoc } from "../engine/trendbeta";
import { loadDvol, dvolMap, dvolCurrencyFor } from "../lib/deribit";
import { sendTelegram } from "../lib/telegram";
import type { Id } from "../../convex/_generated/dataModel";

// result shape every kind-specific forward step returns, fed to the SAME paper
// P&L / kill-switch / applyStep accounting as the DSL path.
interface ForwardStep {
  stepTs: number;
  portRet: number;
  newPositions: { symbol: string; weight: number; entryPrice?: number }[];
  trades: { symbol: string; ts: number; weightFrom: number; weightTo: number; price: number; fillPrice: number; costUsd: number; note?: string }[];
}

// IV-vol sleeve forward step: long-flat ONE coin (BTC/ETH) from the point-in-time
// DVOL / IV-RV z-score regime. Mirrors backtestIv's decision rule (zPast reads
// ONLY days strictly before i, so the weight at the latest closed day uses no
// future info — no look-ahead). Feeds the same paper P&L tracking.
async function ivForwardStep(
  doc: IvSleeveDoc, params: Record<string, number>, equity: number,
  prevWeight: number, prevPrice: number, lastStepTs: number | undefined,
): Promise<ForwardStep | null> {
  const cur = dvolCurrencyFor(doc.symbol);
  if (!cur) return null;
  const [bars, dvolSeries] = await Promise.all([loadBars(doc.symbol, "1d"), loadDvol(cur)]);
  if (!bars || !dvolSeries) return null;
  const S = buildIvDaily(bars, dvolMap(dvolSeries), doc.rvWin);
  const n = S.t.length;
  if (n < 2) return null;
  const zWin = Math.max(20, Math.round(params.zWin ?? doc.zWin));
  const thresh = params.thresh ?? doc.thresh;
  const SLIP_D: Record<string, number> = { "BTC/USDT": 1.5, "ETH/USDT": 2 };
  const slip = (SLIP_D[doc.symbol] ?? 2) / 1e4;
  // trailing z over days STRICTLY before i (point-in-time, matches engine zPast)
  const zPast = (arr: number[], i: number, win: number): number => {
    const lo = Math.max(0, i - win); let s = 0, sq = 0, k = 0;
    for (let j = lo; j < i; j++) { s += arr[j]; sq += arr[j] * arr[j]; k++; }
    if (k < 20) return 0;
    const m = s / k, sd = Math.sqrt(Math.max(1e-12, sq / k - m * m));
    return (arr[i] - m) / sd;
  };
  const ivrv = S.dvol.map((d, i) => d - S.rv[i]);
  const i = n - 1;                                  // the latest CLOSED day
  // mark-to-market: prev weight earned the move into day i (close_{i-1} -> close_i)
  const closeI = bars.c[bars.c.length - 1];
  let portRet = 0;
  if (prevWeight !== 0 && prevPrice > 0) portRet += prevWeight * (closeI / prevPrice - 1);
  // funding while long since last step (point-in-time)
  if (bars.fundingT && bars.fundingR && lastStepTs) {
    for (let fi = bars.fundingT.length - 1; fi >= 0; fi--) {
      const ft = bars.fundingT[fi];
      if (ft <= lastStepTs) break;
      if (ft <= Date.now()) portRet -= prevWeight * bars.fundingR[fi];
    }
  }
  // decide target weight at day i from info <= i (zPast strictly < i)
  let want = 0;
  if (doc.signal === "dvol_high") want = zPast(S.dvol, i, zWin) > thresh ? 1 : 0;
  else if (doc.signal === "dvol_low") want = zPast(S.dvol, i, zWin) < -thresh ? 1 : 0;
  else if (doc.signal === "ivrv_high") want = zPast(ivrv, i, zWin) > thresh ? 1 : 0;
  else want = zPast(ivrv, i, zWin) < -thresh ? 1 : 0;
  const wTo = want * Math.min(doc.risk.maxLeverage, 1);
  const trades: ForwardStep["trades"] = [];
  if (Math.abs(wTo - prevWeight) > 0.02) {
    const side = Math.sign(wTo - prevWeight);
    const tradeCost = Math.abs(wTo - prevWeight) * (DEFAULT_FEE_BPS / 1e4 + slip);
    portRet -= tradeCost;
    trades.push({ symbol: doc.symbol, ts: S.t[i], weightFrom: prevWeight, weightTo: wTo, price: closeI, fillPrice: closeI * (1 + side * slip), costUsd: tradeCost * equity, note: `iv:${doc.signal}` });
  }
  const newPositions = [{ symbol: doc.symbol, weight: Math.abs(wTo - prevWeight) > 0.02 ? wTo : prevWeight, entryPrice: closeI }];
  return { stepTs: S.t[i], portRet, newPositions, trades };
}

// TREND-BETA forward step: long-flat ONE coin when close > SMA(win), else flat.
// Decision at the latest CLOSED day uses closes <= that day (point-in-time SMA, no
// look-ahead). Charges fee+slip on flips + funding while long. Same paper P&L path.
async function trendForwardStep(
  doc: TrendBetaDoc, params: Record<string, number>, equity: number,
  prevWeight: number, prevPrice: number, lastStepTs: number | undefined,
): Promise<ForwardStep | null> {
  const bars = await loadBars(doc.symbol, "1d");
  if (!bars) return null;
  const S = buildTrendDaily(bars);
  const n = S.t.length;
  const win = Math.max(20, Math.round(params.smaWin ?? doc.smaWin));
  if (n < win + 2) return null;
  const SLIP_D: Record<string, number> = { "BTC/USDT": 1.5, "ETH/USDT": 2, "SOL/USDT": 3 };
  const slip = (SLIP_D[doc.symbol] ?? 3) / 1e4;
  const maxLev = Math.max(1, doc.risk.maxLeverage ?? 1);
  const i = n - 1;                                   // latest CLOSED day
  const closeI = bars.c[bars.c.length - 1];
  // mark-to-market: prev weight earned the move into day i
  let portRet = 0;
  if (prevWeight !== 0 && prevPrice > 0) portRet += prevWeight * (closeI / prevPrice - 1);
  // funding while long since last step (point-in-time)
  if (bars.fundingT && bars.fundingR && lastStepTs) {
    for (let fi = bars.fundingT.length - 1; fi >= 0; fi--) {
      const ft = bars.fundingT[fi];
      if (ft <= lastStepTs) break;
      if (ft <= Date.now()) portRet -= prevWeight * bars.fundingR[fi];
    }
  }
  // SMA over closes (i-win, i] — only info <= i (no look-ahead)
  let sma = 0; for (let k = i - win + 1; k <= i; k++) sma += S.close[k]; sma /= win;
  // HONEST LIQUIDATION (leveraged only): if the intrabar low on the day just closed
  // breached the liq distance (1/lev - maint margin), the leveraged long is wiped.
  // At 1.5x the distance is ~-66% intrabar so this ~never triggers on a daily bar —
  // but it tracks the real flash-crash tail that a daily model understates.
  const MAINT = 0.005;
  if (maxLev > 1 && prevWeight > 0 && prevPrice > 0 && bars.l && bars.l.length === bars.c.length) {
    const intrabarLow = bars.l[bars.l.length - 1] / prevPrice - 1;
    const liqDist = -(1 / prevWeight - MAINT);
    if (intrabarLow <= liqDist) {
      // wiped to liquidation: lose the full margin on the position, go flat
      portRet = liqDist; 
      const np = [{ symbol: doc.symbol, weight: 0, entryPrice: closeI }];
      return { stepTs: S.t[i], portRet, newPositions: np, trades: [{ symbol: doc.symbol, ts: S.t[i], weightFrom: prevWeight, weightTo: 0, price: closeI, fillPrice: closeI, costUsd: 0, note: `LIQUIDATED ${maxLev}x` }] };
    }
  }
  const wTo = S.close[i] > sma ? maxLev : 0;          // long if above SMA, else flat
  const trades: ForwardStep["trades"] = [];
  if (Math.abs(wTo - prevWeight) > 0.02) {
    const side = Math.sign(wTo - prevWeight);
    const tradeCost = Math.abs(wTo - prevWeight) * (DEFAULT_FEE_BPS / 1e4 + slip);
    portRet -= tradeCost;
    trades.push({ symbol: doc.symbol, ts: S.t[i], weightFrom: prevWeight, weightTo: wTo, price: closeI, fillPrice: closeI * (1 + side * slip), costUsd: tradeCost * equity, note: `trend:sma${win}` });
  }
  const newPositions = [{ symbol: doc.symbol, weight: Math.abs(wTo - prevWeight) > 0.02 ? wTo : prevWeight, entryPrice: closeI }];
  return { stepTs: S.t[i], portRet, newPositions, trades };
}

// ============================================================ CORE-4 PORTFOLIO
// The FLAGSHIP multi-coin sleeve: BTC+ETH+SOL+BNB, each running Daniel's chop-gated
// trend, equal-weight, whole book levered `leverage` (1.45x). Each step we compute
// every coin's chop-trend target weight point-in-time (reusing targetWeight), size
// it 1/N of the book, scale the book by leverage, and combine into ONE book P&L.
// Per-coin positions tracked for status; honest funding + 1.45x liquidation distance.
interface Core4Doc {
  name: string; kind: "core4"; tf?: string;
  coins: { symbol: string; smaWin: number; chopThr: number }[];
  leverage: number; risk: StrategyDoc["risk"];
}
function isCore4(d: unknown): d is Core4Doc {
  return !!d && typeof d === "object" && (d as { kind?: string }).kind === "core4" && Array.isArray((d as Core4Doc).coins);
}
// per-coin chop-trend DSL (Daniel's mechanism) with that coin's WF-picked params
function chopTrendDoc(smaWin: number, chopThr: number, risk: StrategyDoc["risk"]): StrategyDoc {
  const close = { op: "price", field: "close" };
  const sma = { op: "sma", src: close, period: { op: "const", value: smaWin } };
  return {
    name: `chop_sma${smaWin}_c${chopThr}`, tf: "1d", hypothesis: "chop-gated trend",
    longEntry: { op: "and", a: { op: "gt", a: close, b: sma }, b: { op: "lt", a: { op: "choppiness", src: close, period: { op: "const", value: 14 } }, b: { op: "const", value: chopThr } } },
    longExit: { op: "lt", a: close, b: sma },
    params: {}, risk,
  } as unknown as StrategyDoc;
}

async function core4ForwardStep(
  doc: Core4Doc, equity: number, prevPositions: Map<string, { weight: number; entryPrice?: number }>,
  lastStepTs: number | undefined, getBars: (s: string, tf: string) => Promise<Bars | null>,
): Promise<ForwardStep | null> {
  const N = doc.coins.length || 1;
  const lev = doc.leverage ?? 1.45;
  const MAINT = 0.005;
  let stepTs = 0, portRet = 0;
  const trades: ForwardStep["trades"] = [];
  const newPositions: ForwardStep["newPositions"] = [];

  for (const coin of doc.coins) {
    const bars = await getBars(coin.symbol, "1d");
    if (!bars) { // keep prior position if data missing this step
      const prev = prevPositions.get(coin.symbol);
      newPositions.push({ symbol: coin.symbol, weight: prev?.weight ?? 0, entryPrice: prev?.entryPrice });
      continue;
    }
    const cur = prevPositions.get(coin.symbol);
    const prevWeight = cur?.weight ?? 0;       // already includes the 1/N * leverage sizing? NO — store the COIN weight (0..1), apply N/lev at book level
    const prevPrice = cur?.entryPrice ?? 0;
    const prevDir = Math.sign(prevWeight);
    const cdoc = chopTrendDoc(coin.smaWin, coin.chopThr, doc.risk);
    // targetWeight gives the per-coin vol-targeted long-flat weight (0..1), point-in-time
    const t = targetWeight(cdoc, {}, bars, prevDir, prevPrice);
    stepTs = Math.max(stepTs, t.lastTs);
    const slip = (SLIP_BPS[coin.symbol] ?? 4) / 10_000;

    // effective book contribution of this coin = (1/N) * leverage * coinWeight
    const bookFrac = (1 / N) * lev;
    // mark-to-market on the bar just closed: this coin's prior contribution
    if (prevWeight !== 0 && prevPrice > 0) {
      portRet += bookFrac * prevWeight * (t.lastClose / prevPrice - 1);
    }
    // funding while long since last step (point-in-time)
    if (bars.fundingT && bars.fundingR && lastStepTs) {
      for (let fi = bars.fundingT.length - 1; fi >= 0; fi--) {
        const ft = bars.fundingT[fi];
        if (ft <= lastStepTs) break;
        if (ft <= Date.now()) portRet -= bookFrac * prevWeight * bars.fundingR[fi];
      }
    }
    // HONEST 1.45x LIQUIDATION: a coin's effective leverage = lev * coinWeight. At
    // 1.45x (coinWeight~1) the liq distance is ~-69% intrabar, so this ~never fires
    // on a daily bar — but it tracks the real flash-crash tail.
    const effLev = lev * prevWeight;
    if (effLev > 1 && prevPrice > 0 && bars.l && bars.l.length === bars.c.length) {
      const intrabarLow = bars.l[bars.l.length - 1] / prevPrice - 1;
      const liqDist = -(1 / effLev - MAINT);
      if (intrabarLow <= liqDist) {
        // this coin's slice is wiped: lose its book fraction of margin, go flat
        portRet += (1 / N) * liqDist - bookFrac * prevWeight * (t.lastClose / prevPrice - 1); // undo the MTM, apply liq loss
        trades.push({ symbol: coin.symbol, ts: t.lastTs, weightFrom: prevWeight, weightTo: 0, price: t.lastClose, fillPrice: t.lastClose, costUsd: 0, note: `LIQUIDATED ${effLev.toFixed(2)}x` });
        newPositions.push({ symbol: coin.symbol, weight: 0, entryPrice: t.lastClose });
        continue;
      }
    }
    // rebalance this coin to its target weight
    const wTo = t.weight;
    if (Math.abs(wTo - prevWeight) > 0.02) {
      const side = Math.sign(wTo - prevWeight);
      const tradeCost = bookFrac * Math.abs(wTo - prevWeight) * ((DEFAULT_FEE_BPS / 1e4) + slip);
      portRet -= tradeCost;
      trades.push({ symbol: coin.symbol, ts: t.lastTs, weightFrom: prevWeight, weightTo: wTo, price: t.lastClose, fillPrice: t.lastClose * (1 + side * slip), costUsd: tradeCost * equity, note: `core4:sma${coin.smaWin}c${coin.chopThr}` });
    }
    newPositions.push({ symbol: coin.symbol, weight: Math.abs(wTo - prevWeight) > 0.02 ? wTo : prevWeight, entryPrice: t.lastClose });
  }
  // leverage borrow cost on EXPOSED days only (book held a levered position)
  const anyExposed = newPositions.some((p) => Math.abs(p.weight) > 1e-6);
  if (lev > 1 && anyExposed) portRet -= (lev - 1) * (0.10 / 365);
  if (stepTs === 0) return null;
  return { stepTs, portRet, newPositions, trades };
}

const EWMA_LAMBDA = 0.94;

/** Compute the strategy's target weight for a symbol from the latest CLOSED bar. */
function targetWeight(doc: StrategyDoc, params: Record<string, number>, bars: Bars, prevDir: number, prevPrice = 0): { dir: number; weight: number; lastClose: number; lastTs: number } {
  // use the trailing 3000 bars for warm indicators
  const n = bars.t.length;
  const from = Math.max(0, n - 3000);
  const slice: Bars = {
    symbol: bars.symbol, tf: bars.tf,
    t: bars.t.slice(from), o: bars.o.slice(from), h: bars.h.slice(from),
    l: bars.l.slice(from), c: bars.c.slice(from), v: bars.v.slice(from),
    fundingT: bars.fundingT, fundingR: bars.fundingR, // funding ops need the carry series
  };
  const inp = toArrays(slice);
  const sig = computeSignals(doc, inp, params);
  const i = slice.t.length - 1;
  let dir = prevDir;
  if (dir === 1 && sig.longExit[i]) dir = 0;
  else if (dir === -1 && sig.shortExit && sig.shortExit[i]) dir = 0;
  // ---- STOPS (point-in-time): a held position is also exited by the hard ATR stop
  //      and the profit trailing stop, recomputed from bars <= now. We find the entry
  //      bar by prevPrice and walk the peak favorable close forward (no look-ahead).
  if (dir !== 0 && prevPrice > 0) {
    // locate entry bar: the most recent bar whose close ~= prevPrice (entry fill)
    let entryI = -1;
    for (let k = i; k >= Math.max(1, i - 800); k--) { if (Math.abs(inp.c[k] - prevPrice) / prevPrice < 1e-4) { entryI = k; break; } }
    if (entryI < 0) entryI = Math.max(1, i - 1); // fallback: assume recent
    const closeNow = inp.c[i];
    // hard ATR stop
    const atr = sig.atr14[entryI];
    if (doc.risk.stopAtrMult && Number.isFinite(atr)) {
      const stopLvl = dir === 1 ? prevPrice - doc.risk.stopAtrMult * atr : prevPrice + doc.risk.stopAtrMult * atr;
      if (dir === 1 && closeNow <= stopLvl) dir = 0;
      if (dir === -1 && closeNow >= stopLvl) dir = 0;
    }
    // PROFIT trailing stop: peak favorable close since entry; arm at trailActivate; exit on trailOffset retrace
    const { trailActivate, trailOffset } = doc.risk;
    if (dir !== 0 && trailActivate !== undefined && trailOffset !== undefined && trailActivate > 0 && trailOffset > 0) {
      let peak = inp.c[entryI];
      for (let k = entryI; k <= i; k++) peak = dir === 1 ? Math.max(peak, inp.c[k]) : Math.min(peak, inp.c[k]);
      const curProfit = dir === 1 ? closeNow / prevPrice - 1 : prevPrice / closeNow - 1;
      const retrace = dir === 1 ? peak / closeNow - 1 : closeNow / peak - 1;
      if (curProfit >= trailActivate && retrace >= trailOffset) dir = 0; // armed (ran far) AND gave back trailOffset -> exit
    }
  }
  if (dir === 0) {
    if (sig.longEntry[i]) dir = 1;
    else if (sig.shortEntry && sig.shortEntry[i]) dir = -1;
  }
  // vol targeting from EWMA of close returns
  let ewmaVar = 0; let init = false;
  for (let k = Math.max(1, i - 500); k <= i; k++) {
    const r = inp.c[k] / inp.c[k - 1] - 1;
    if (!init) { ewmaVar = r * r; init = true; } else ewmaVar = EWMA_LAMBDA * ewmaVar + (1 - EWMA_LAMBDA) * r * r;
  }
  const ppy = PPY[bars.tf] ?? 8760;
  const perBarTargetVar = (doc.risk.volTargetAnnual ** 2) / ppy;
  const scale = ewmaVar > 1e-12 ? Math.sqrt(perBarTargetVar / ewmaVar) : 1;
  const weight = dir * Math.min(doc.risk.maxLeverage, Math.max(0, scale));
  return { dir, weight, lastClose: inp.c[i], lastTs: slice.t[i] };
}

export const paperStep = schedules.task({
  id: "paper-step",
  cron: "12 * * * *",
  machine: "small-2x",
  maxDuration: 1500,
  run: async () => {
    const cx = convex();
    const cfg = mergeConfig(await cx.query(api.pipeline.getConfig, { key: "app" }));
    const incubating = await cx.query(api.candidates.listByStage, { stage: "incubating" });
    const eligible = await cx.query(api.candidates.listByStage, { stage: "eligible" });
    const champion = await cx.query(api.candidates.champion, {});
    const actives = [...incubating, ...eligible, ...(champion ? [champion] : [])];
    if (!actives.length) { logger.log("no active paper strategies"); return { stepped: 0 }; }

    // bars cache keyed by symbol|tf — strategies choose their own timeframe
    const barsCache = new Map<string, Bars | null>();
    const getBars = async (sym: string, tf: string): Promise<Bars | null> => {
      const key = `${sym}|${tf}`;
      if (!barsCache.has(key)) barsCache.set(key, await loadBars(sym, tf));
      return barsCache.get(key) ?? null;
    };
    const nSym = cfg.universe.length || 1;
    const costRate = (sym: string) => (DEFAULT_FEE_BPS + (SLIP_BPS[sym] ?? 4)) / 10_000;

    let stepped = 0;
    for (const cand of actives) {
      try {
        const candidateId = cand._id as Id<"candidates">;
        const acct = await cx.query(api.paper.getAccount, { candidateId });
        if (!acct || acct.halted) continue;
        const rawDoc = JSON.parse(cand.dsl) as unknown;
        const params = cand.bestParams ? JSON.parse(cand.bestParams) as Record<string, number> : {};
        const positions = await cx.query(api.paper.positionsFor, { candidateId });
        const posBySym = new Map(positions.map((p) => [p.symbol, p]));

        let stepTs = 0;
        let portRet = 0;
        let costUsd = 0;
        let newPositions: { symbol: string; weight: number; entryPrice?: number }[] = [];
        let trades: { symbol: string; ts: number; weightFrom: number; weightTo: number; price: number; fillPrice: number; costUsd: number; note?: string }[] = [];

        // ---- KIND-AWARE DISPATCH ----------------------------------------------
        // ivsleeve trades ONE coin from the point-in-time DVOL signal; onchain /
        // xsection have their own engines (framework ready, not yet seeded). DSL
        // sleeves use the per-symbol compiled-expr path below.
        if (isCore4(rawDoc)) {
          // FLAGSHIP CORE-4 portfolio: step all 4 coins, combine equal-weight x leverage.
          const prevMap = new Map(positions.map((p) => [p.symbol, { weight: p.weight, entryPrice: p.entryPrice }]));
          const step = await core4ForwardStep(rawDoc, acct.equity, prevMap, acct.lastStepTs, getBars);
          if (!step) { logger.log(`core4 "${cand.name}": bars unavailable, skipped`); continue; }
          stepTs = step.stepTs; portRet = step.portRet; newPositions = step.newPositions; trades = step.trades;
          for (const t of trades) costUsd += t.costUsd;
        } else if (isIvSleeve(rawDoc)) {
          const cur = posBySym.get(rawDoc.symbol);
          const step = await ivForwardStep(rawDoc, params, acct.equity, cur?.weight ?? 0, cur?.entryPrice ?? 0, acct.lastStepTs);
          if (!step) { logger.log(`iv sleeve "${cand.name}": DVOL/bars unavailable, skipped`); continue; }
          stepTs = step.stepTs; portRet = step.portRet; newPositions = step.newPositions; trades = step.trades;
          for (const t of trades) costUsd += t.costUsd;
        } else if (isTrendBeta(rawDoc)) {
          // trend-beta trades ONE coin long-flat from the point-in-time SMA filter.
          const cur = posBySym.get(rawDoc.symbol);
          const step = await trendForwardStep(rawDoc, params, acct.equity, cur?.weight ?? 0, cur?.entryPrice ?? 0, acct.lastStepTs);
          if (!step) { logger.log(`trend sleeve "${cand.name}": bars unavailable, skipped`); continue; }
          stepTs = step.stepTs; portRet = step.portRet; newPositions = step.newPositions; trades = step.trades;
          for (const t of trades) costUsd += t.costUsd;
        } else if (isOcSleeve(rawDoc) || isXSection(rawDoc)) {
          // FRAMEWORK READY: route to backtestOc/backtestXSection's forward signal
          // when these kinds are seeded. Not seeded today (failed the bootstrap
          // battery), so we skip rather than mis-trade them as DSL.
          logger.log(`paper-step: kind "${(rawDoc as { kind?: string }).kind}" forward-testing not yet enabled ("${cand.name}") — skipped`);
          continue;
        } else {
        // ---- DSL PATH (unchanged) ---------------------------------------------
        const doc = rawDoc as StrategyDoc;
        const candTf = doc.tf ?? cfg.tf;
        for (const sym of cfg.universe) {
          const bars = await getBars(sym, candTf);
          if (!bars) continue;
          const cur = posBySym.get(sym);
          const prevWeight = cur?.weight ?? 0;
          const prevPrice = cur?.entryPrice ?? 0;
          const prevDir = Math.sign(prevWeight);
          const t = targetWeight(doc, params, bars, prevDir, prevPrice);
          stepTs = Math.max(stepTs, t.lastTs);

          // mark-to-market on the bar we just closed
          if (prevWeight !== 0 && prevPrice > 0) {
            portRet += (prevWeight / nSym) * (t.lastClose / prevPrice - 1);
          }
          // funding accrued since last step
          if (bars.fundingT && bars.fundingR && acct.lastStepTs) {
            for (let fi = bars.fundingT.length - 1; fi >= 0; fi--) {
              const ft = bars.fundingT[fi];
              if (ft <= acct.lastStepTs) break;
              if (ft <= Date.now()) portRet -= (prevWeight / nSym) * bars.fundingR[fi];
            }
          }
          // rebalance to target with simulated fill
          const wTo = t.weight;
          if (Math.abs(wTo - prevWeight) > 0.02) {
            const slip = (SLIP_BPS[sym] ?? 4) / 10_000;
            const side = Math.sign(wTo - prevWeight);
            const fillPrice = t.lastClose * (1 + side * slip);
            const tradeCost = Math.abs(wTo - prevWeight) / nSym * costRate(sym);
            portRet -= tradeCost;
            costUsd += tradeCost * acct.equity;
            trades.push({ symbol: sym, ts: t.lastTs, weightFrom: prevWeight, weightTo: wTo, price: t.lastClose, fillPrice, costUsd: tradeCost * acct.equity });
          }
          newPositions.push({ symbol: sym, weight: Math.abs(wTo - prevWeight) > 0.02 ? wTo : prevWeight, entryPrice: t.lastClose });
        }
        } // end DSL path

        if (stepTs === 0) continue;
        const newEquity = acct.equity * (1 + portRet);

        // ---- kill-switch ----
        const daySnaps = await cx.query(api.paper.snapshots, { candidateId, sinceTs: stepTs - 86400_000 });
        const weekSnaps = await cx.query(api.paper.snapshots, { candidateId, sinceTs: stepTs - 7 * 86400_000 });
        const monthSnaps = await cx.query(api.paper.snapshots, { candidateId, sinceTs: stepTs - 30 * 86400_000 });
        const ddFrom = (snaps: { equity: number }[]) => {
          if (!snaps.length) return 0;
          const maxEq = Math.max(...snaps.map((s) => s.equity), newEquity);
          return newEquity / maxEq - 1;
        };
        let halted = false, haltReason: string | undefined;
        if (ddFrom(daySnaps) < cfg.killSwitch.dailyDD) { halted = true; haltReason = `daily DD ${(ddFrom(daySnaps) * 100).toFixed(1)}%`; }
        else if (ddFrom(weekSnaps) < cfg.killSwitch.weeklyDD) { halted = true; haltReason = `weekly DD ${(ddFrom(weekSnaps) * 100).toFixed(1)}%`; }
        else if (ddFrom(monthSnaps) < cfg.killSwitch.monthlyDD) { halted = true; haltReason = `monthly DD ${(ddFrom(monthSnaps) * 100).toFixed(1)}%`; }

        await cx.mutation(api.paper.applyStep, {
          candidateId, ts: stepTs, equity: newEquity, ret: portRet,
          halted: halted || undefined, haltReason,
          positions: halted ? newPositions.map((p) => ({ ...p, weight: 0 })) : newPositions,
          trades,
        });
        stepped++;

        if (halted) {
          await sendTelegram(`🛑 *finance-engine-v2 kill-switch*\n"${cand.name}" (${cand.stage}) halted: ${haltReason}\nEquity: $${newEquity.toFixed(0)}`);
          await cx.mutation(api.pipeline.addLesson, {
            source: cand.source, candidateId,
            text: `KILL-SWITCH in paper: "${cand.name}" halted (${haltReason}) after passing the full gauntlet. Live regime differs from validation.`,
          });
          if (cand.stage === "champion") {
            await cx.mutation(api.promotions.demoteChampion, { reason: `kill-switch: ${haltReason}` });
            await sendTelegram(`⚠️ Champion demoted + rolled back to previous champion.`);
          }
        }
      } catch (err) {
        logger.error(`paper step failed for ${cand.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
    logger.log(`paper step: ${stepped}/${actives.length} strategies updated`);
    return { stepped };
  },
});
