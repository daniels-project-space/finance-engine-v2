// The promotion gauntlet. Single mandatory pipeline with ABSOLUTE floors —
// the fix for the old engine's fatal flaw (champion-relative 2-of-3 promotion
// of negative-Sharpe strategies). Every stage can kill; every kill produces a
// lesson string the evolution loop learns from.
//
// Stage order (cheap → expensive):
//   S0 static  → S2 train fit → S3 walk-forward (re-tuning) → S4 cross-symbol
//   → S5 statistics (DSR, permutation, bootstrap) → S5b stress → done.
// S1 novelty/penalty and S6 sealed-holdout one-shot need DB state, so they
// live in the Trigger task; S6 calls evaluateSealed() here for the math.
// All stages S2–S5b operate ONLY on data strictly before sealDate.

import { indexOfTs, runBacktest } from "./backtest";
import { bootstrapSharpeCI, dsr, permutationTest } from "./stats";
import { runStress, type StressReport } from "./stress";
import { tune } from "./tune";
import { walkForward, type WfReport } from "./walkforward";
import { validateStrategy } from "./dsl";
import { DEFAULT_FEE_BPS, SLIP_BPS, PPY, type Bars, type GateFloors, type StrategyDoc } from "./types";

export interface StageOutcome {
  stage: string;
  passed: boolean;
  reason?: string;
  detail?: unknown;
  durationMs: number;
}

export interface Curve { t: number[]; eq: number[] }

/** Downsample an equity path to ≤maxPts points for dashboard storage. */
export function downsampleCurve(ts: number[], eq: Float64Array | number[], fromI: number, toI: number, maxPts = 300): Curve {
  const n = toI - fromI + 1;
  const step = Math.max(1, Math.ceil(n / maxPts));
  const t: number[] = [], e: number[] = [];
  for (let i = fromI; i <= toI; i += step) {
    t.push(ts[i]);
    e.push(Number((eq as Float64Array)[i]));
  }
  if (t[t.length - 1] !== ts[toI]) { t.push(ts[toI]); e.push(Number((eq as Float64Array)[toI])); }
  return { t, eq: e };
}

export interface GauntletReport {
  passed: boolean;
  failedStage?: string;
  failedReason?: string;
  stages: StageOutcome[];
  bestParams?: Record<string, number>;
  /** downsampled equity paths for the dashboard */
  curves?: { full?: Curve; wf?: Curve };
  metrics: {
    trainSharpe?: number;
    wfPooledSharpe?: number;
    wfPctPositive?: number;
    wfWorstMonth?: number;
    wfMaxDD?: number;
    fullSharpe?: number;
    fullSortino?: number;
    fullMaxDD?: number;
    fullCagr?: number;
    winRate?: number;
    fullTrades?: number;
    exposure?: number;
    dsr?: number;
    permutationP?: number;
    bootstrapP5?: number;
    crossSymbolPositive?: number;
    composite?: number;
  };
}

export function optsFor(symbol: string, tf: string) {
  return {
    cost: { feeBps: DEFAULT_FEE_BPS, slipBps: SLIP_BPS[symbol] ?? 4 },
    ppy: PPY[tf] ?? 8760,
  };
}

export interface GauntletInputs {
  doc: StrategyDoc;
  /** primary symbol bars (the evolution symbol) */
  primary: Bars;
  /** other universe symbols for the generalization gate */
  others: Bars[];
  sealTs: number;       // data >= sealTs is NEVER touched by S2–S5b
  floors: GateFloors;
  nTrialsTotal: number; // total candidates ever evaluated (for DSR deflation)
  log?: (msg: string) => void;
}

export function runGauntlet(g: GauntletInputs): GauntletReport {
  const stages: StageOutcome[] = [];
  const metrics: GauntletReport["metrics"] = {};
  const t0 = () => Date.now();
  const curves: GauntletReport["curves"] = {};
  const fail = (stage: string, reason: string, started: number, detail?: unknown): GauntletReport => {
    stages.push({ stage, passed: false, reason, detail, durationMs: Date.now() - started });
    return { passed: false, failedStage: stage, failedReason: reason, stages, metrics, curves };
  };

  const { doc, primary, floors } = g;
  const opts = optsFor(primary.symbol, primary.tf);
  const sealI = indexOfTs(primary.t, g.sealTs); // first sealed index
  const devEndI = sealI - 1;
  if (devEndI < 5000) throw new Error("not enough pre-seal data");

  // ---- S0 static ----------------------------------------------------------
  let started = t0();
  const errors = validateStrategy(doc);
  if (errors.length) return fail("S0-static", errors.join("; "), started);
  stages.push({ stage: "S0-static", passed: true, durationMs: Date.now() - started });

  // ---- S2 train fit (first 70% of pre-seal data) --------------------------
  started = t0();
  const trainEndI = Math.floor(devEndI * 0.7);
  const fit = tune(doc, primary, opts, { startI: 1, endI: trainEndI }, 60, 11);
  metrics.trainSharpe = fit.sharpe;
  const years = trainEndI / opts.ppy;
  const tradesPerYear = fit.trades / Math.max(0.1, years);
  if (fit.sharpe < floors.trainMinSharpe) return fail("S2-train", `train sharpe ${fit.sharpe.toFixed(2)} < ${floors.trainMinSharpe}`, started, fit);
  if (tradesPerYear < floors.trainMinTradesPerYear) return fail("S2-train", `${tradesPerYear.toFixed(0)} trades/yr < ${floors.trainMinTradesPerYear}`, started, fit);
  const trainRes = runBacktest(doc, primary, fit.params, opts, { startI: 1, endI: trainEndI });
  if (trainRes.metrics.maxDD < floors.trainMaxDD) return fail("S2-train", `train maxDD ${(trainRes.metrics.maxDD * 100).toFixed(0)}% worse than ${floors.trainMaxDD * 100}%`, started, fit);
  stages.push({ stage: "S2-train", passed: true, durationMs: Date.now() - started, detail: { sharpe: fit.sharpe, tradesPerYear } });
  g.log?.(`S2 pass sharpe=${fit.sharpe.toFixed(2)}`);

  // ---- S3 walk-forward with re-tuning (pre-seal only) ---------------------
  started = t0();
  const wf = walkForward(doc, primary, opts, { trainMonths: 12, stepMonths: 1, tuneTrials: 40, endTs: g.sealTs });
  metrics.wfPooledSharpe = wf.pooledSharpe;
  metrics.wfPctPositive = wf.pctPositive;
  metrics.wfWorstMonth = wf.worstWindowRet;
  metrics.wfMaxDD = wf.pooledMaxDD;
  // WF OOS equity curve (timestamps spread across the OOS span)
  if (wf.pooledRet.length > 10 && wf.windows.length) {
    const eq = new Float64Array(wf.pooledRet.length);
    let acc = 1;
    for (let i = 0; i < wf.pooledRet.length; i++) { acc *= 1 + wf.pooledRet[i]; eq[i] = acc; }
    const t0w = wf.windows[0].testStartTs, t1w = wf.windows[wf.windows.length - 1].testEndTs;
    const ts = Array.from({ length: eq.length }, (_, i) => t0w + ((t1w - t0w) * i) / Math.max(1, eq.length - 1));
    curves.wf = downsampleCurve(ts, eq, 0, eq.length - 1, 240);
  }
  if (wf.windows.length < 12) return fail("S3-walkforward", `only ${wf.windows.length} WF windows`, started, summarizeWf(wf));
  if (wf.pooledSharpe < floors.wfMinMeanSharpe) return fail("S3-walkforward", `OOS pooled sharpe ${wf.pooledSharpe.toFixed(2)} < ${floors.wfMinMeanSharpe}`, started, summarizeWf(wf));
  if (wf.pctPositive < floors.wfMinPctPositive) return fail("S3-walkforward", `${(wf.pctPositive * 100).toFixed(0)}% positive months < ${floors.wfMinPctPositive * 100}%`, started, summarizeWf(wf));
  if (wf.worstWindowRet < floors.wfWorstMonth) return fail("S3-walkforward", `worst month ${(wf.worstWindowRet * 100).toFixed(1)}% < ${floors.wfWorstMonth * 100}%`, started, summarizeWf(wf));
  if (wf.pooledMaxDD < floors.wfMaxDD) return fail("S3-walkforward", `OOS maxDD ${(wf.pooledMaxDD * 100).toFixed(0)}%`, started, summarizeWf(wf));
  stages.push({ stage: "S3-walkforward", passed: true, durationMs: Date.now() - started, detail: summarizeWf(wf) });
  g.log?.(`S3 pass oosSharpe=${wf.pooledSharpe.toFixed(2)} pos=${(wf.pctPositive * 100).toFixed(0)}%`);

  // ---- S4 cross-symbol generalization --------------------------------------
  started = t0();
  let positive = 1; // primary already positive by S3
  const perSymbol: Record<string, number> = { [primary.symbol]: wf.pooledSharpe };
  for (const other of g.others) {
    const oOpts = optsFor(other.symbol, other.tf);
    const owf = walkForward(doc, other, oOpts, { trainMonths: 12, stepMonths: 2, tuneTrials: 25, endTs: g.sealTs });
    perSymbol[other.symbol] = owf.pooledSharpe;
    if (owf.pooledSharpe > 0 && owf.pctPositive >= 0.5) positive++;
  }
  metrics.crossSymbolPositive = positive;
  if (positive < floors.crossSymbolMinPositive) return fail("S4-cross-symbol", `WF-positive on ${positive}/${g.others.length + 1} symbols < ${floors.crossSymbolMinPositive}`, started, perSymbol);
  stages.push({ stage: "S4-cross-symbol", passed: true, durationMs: Date.now() - started, detail: perSymbol });
  g.log?.(`S4 pass positive=${positive}`);

  // ---- S5 statistics (on full pre-seal run with WF-median params) ----------
  started = t0();
  const finalParams = medianParams(doc, wf);
  const full = runBacktest(doc, primary, finalParams, opts, { startI: 1, endI: devEndI });
  metrics.fullSharpe = full.metrics.sharpe;
  metrics.fullSortino = full.metrics.sortino;
  metrics.fullMaxDD = full.metrics.maxDD;
  metrics.fullCagr = full.metrics.cagr;
  metrics.winRate = full.metrics.winRate;
  metrics.fullTrades = full.metrics.trades;
  metrics.exposure = full.metrics.exposure;
  curves.full = downsampleCurve(primary.t, full.equity, 1, devEndI, 300);
  const d = dsr(full.ret, 2, devEndI, Math.max(g.nTrialsTotal, 10));
  metrics.dsr = d;
  if (d < floors.minDSR) return fail("S5-stats", `DSR ${d.toFixed(3)} < ${floors.minDSR} (deflated for ${g.nTrialsTotal} trials)`, started, { dsr: d });
  const perm = permutationTest(doc, sliceBars(primary, 0, devEndI), finalParams, opts, full.metrics.sharpe, 120);
  metrics.permutationP = perm.p;
  if (perm.p > floors.maxPermutationP) return fail("S5-stats", `permutation p=${perm.p.toFixed(3)} > ${floors.maxPermutationP}`, started, perm);
  const boot = bootstrapSharpeCI(full.ret, 2, devEndI, opts.ppy);
  metrics.bootstrapP5 = boot.p5;
  if (boot.lo <= 0) return fail("S5-stats", `bootstrap 95% CI includes zero [${boot.lo.toFixed(2)}, ${boot.hi.toFixed(2)}]`, started, boot);
  stages.push({ stage: "S5-stats", passed: true, durationMs: Date.now() - started, detail: { dsr: d, permP: perm.p, bootstrap: boot } });
  g.log?.(`S5 pass dsr=${d.toFixed(3)} p=${perm.p.toFixed(3)} ciLo=${boot.lo.toFixed(2)}`);

  // ---- S5b stress ----------------------------------------------------------
  started = t0();
  const stress = runStress(doc, primary, finalParams, opts, { slipMult: floors.stressSlipMultSurvive, crisisMaxDD: floors.stressCrisisMaxDD }, { startI: 1, endI: devEndI });
  if (!stress.slipSurvives) return fail("S5b-stress", `dies at ${floors.stressSlipMultSurvive}x slippage`, started, slimStress(stress));
  if (!stress.perturbSurvives) return fail("S5b-stress", `param perturbation ±15% mean sharpe ${stress.perturbedMeanSharpe.toFixed(2)} < 60% of base`, started, slimStress(stress));
  if (!stress.crisisSurvives) return fail("S5b-stress", `crisis window DD breach`, started, slimStress(stress));
  stages.push({ stage: "S5b-stress", passed: true, durationMs: Date.now() - started, detail: slimStress(stress) });

  metrics.composite = 0.5 * (metrics.wfPooledSharpe ?? 0) + 0.2 * (metrics.fullSharpe ?? 0); // sealed adds 0.3 later
  return { passed: true, stages, metrics, bestParams: finalParams, curves };
}

/** S6 sealed holdout math (one-shot enforcement lives in the task layer). */
export function evaluateSealed(
  doc: StrategyDoc, bars: Bars, params: Record<string, number>, sealTs: number, floors: GateFloors,
): { passed: boolean; reason?: string; sharpe: number; ret: number; maxDD: number; trades: number; curve: Curve } {
  const opts = optsFor(bars.symbol, bars.tf);
  const sealI = indexOfTs(bars.t, sealTs);
  const endI = bars.t.length - 1;
  const warmStart = Math.max(1, sealI - 1000);
  const res = runBacktest(doc, bars, params, opts, { startI: warmStart, endI });
  const sealedEq = new Float64Array(endI + 1).fill(1);
  let s = 0, sq = 0, g = 1, eq = 1, peak = 1, dd = 0, trades = 0;
  for (let i = sealI; i <= endI; i++) {
    const r = res.ret[i]; s += r; sq += r * r; g *= 1 + r;
    eq *= 1 + r; if (eq > peak) peak = eq; const dde = eq / peak - 1; if (dde < dd) dd = dde;
    sealedEq[i] = eq;
  }
  const curve = downsampleCurve(bars.t, sealedEq, sealI, endI, 150);
  for (const tr of res.trades) if (tr.entryI >= sealI) trades++;
  const n = Math.max(1, endI - sealI + 1);
  const mean = s / n, sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
  const sharpe = sd > 1e-12 ? (mean / sd) * Math.sqrt(opts.ppy) : 0;
  const ret = g - 1;
  if (trades < floors.sealedMinTrades) return { passed: false, reason: `${trades} sealed trades < ${floors.sealedMinTrades}`, sharpe, ret, maxDD: dd, trades, curve };
  if (sharpe < floors.sealedMinSharpe) return { passed: false, reason: `sealed sharpe ${sharpe.toFixed(2)} < ${floors.sealedMinSharpe}`, sharpe, ret, maxDD: dd, trades, curve };
  if (ret <= 0) return { passed: false, reason: `sealed return ${(ret * 100).toFixed(1)}% <= 0`, sharpe, ret, maxDD: dd, trades, curve };
  if (dd < floors.sealedMaxDD) return { passed: false, reason: `sealed maxDD ${(dd * 100).toFixed(0)}%`, sharpe, ret, maxDD: dd, trades, curve };
  return { passed: true, sharpe, ret, maxDD: dd, trades, curve };
}

function summarizeWf(wf: WfReport) {
  return {
    windows: wf.windows.length, pooledSharpe: wf.pooledSharpe, meanWindowSharpe: wf.meanWindowSharpe,
    pctPositive: wf.pctPositive, worstWindowRet: wf.worstWindowRet, pooledMaxDD: wf.pooledMaxDD, totalOosTrades: wf.totalOosTrades,
  };
}

function slimStress(s: StressReport) {
  return { baseSharpe: s.baseSharpe, slipRamp: s.slipRamp, perturbedMeanSharpe: s.perturbedMeanSharpe, crisis: s.crisis, ddShufflePct: s.ddShufflePct };
}

/** median of per-window tuned params — robust "deployment" parameterization */
export function medianParams(doc: StrategyDoc, wf: WfReport): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(doc.params ?? {})) {
    const vals = wf.windows.map((w) => w.params[k]).filter((v) => v !== undefined).sort((a, b) => a - b);
    if (!vals.length) { out[k] = doc.params[k].default; continue; }
    let v = vals[Math.floor(vals.length / 2)];
    if (doc.params[k].int) v = Math.round(v);
    out[k] = v;
  }
  return out;
}

export function sliceBars(bars: Bars, fromI: number, toI: number): Bars {
  return {
    symbol: bars.symbol, tf: bars.tf,
    t: bars.t.slice(fromI, toI + 1), o: bars.o.slice(fromI, toI + 1), h: bars.h.slice(fromI, toI + 1),
    l: bars.l.slice(fromI, toI + 1), c: bars.c.slice(fromI, toI + 1), v: bars.v.slice(fromI, toI + 1),
    fundingT: bars.fundingT?.filter((t) => t >= bars.t[fromI] && t <= bars.t[toI]),
    fundingR: bars.fundingT ? bars.fundingR?.filter((_, i) => (bars.fundingT as number[])[i] >= bars.t[fromI] && (bars.fundingT as number[])[i] <= bars.t[toI]) : undefined,
  };
}
