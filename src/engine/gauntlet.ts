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
import { adaptiveTrials, tune } from "./tune";
import { walkForward, type WfReport } from "./walkforward";
import { validateStrategy } from "./dsl";
import { DEFAULT_FEE_BPS, SLIP_BPS, PPY, tfScale, type Bars, type GateFloors, type StrategyDoc } from "./types";

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
  curves?: { full?: Curve; wf?: Curve; port?: Curve };
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
    /** deployed equal-weight portfolio across the universe, all returns OOS */
    portOosSharpe?: number;
    portPctPositive?: number;
    portMaxDD?: number;
    composite?: number;
  };
}

/** Equal-weight merge of per-bar OOS return streams aligned by timestamp. */
export function mergePortfolio(streams: { t: Float64Array; ret: Float64Array }[]): { t: number[]; ret: number[] } {
  const acc = new Map<number, { s: number; n: number }>();
  for (const st of streams) {
    for (let i = 0; i < st.t.length; i++) {
      const ts = st.t[i];
      const cur = acc.get(ts);
      if (cur) { cur.s += st.ret[i]; cur.n++; }
      else acc.set(ts, { s: st.ret[i], n: 1 });
    }
  }
  const t = Array.from(acc.keys()).sort((a, b) => a - b);
  // equal weight across the FULL universe: idle symbols contribute 0, so divide by stream count
  const N = Math.max(1, streams.length);
  return { t, ret: t.map((ts) => (acc.get(ts) as { s: number; n: number }).s / N) };
}

export function seriesStats(ret: number[], t: number[], ppy: number) {
  const n = Math.max(1, ret.length);
  let s = 0, sq = 0;
  for (const r of ret) { s += r; sq += r * r; }
  const mean = s / n, sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
  const sharpe = sd > 1e-12 ? (mean / sd) * Math.sqrt(ppy) : 0;
  let eq = 1, peak = 1, maxDD = 0;
  const monthly = new Map<string, number>();
  const eqOut = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    eq *= 1 + ret[i];
    eqOut[i] = eq;
    if (eq > peak) peak = eq;
    const d = eq / peak - 1; if (d < maxDD) maxDD = d;
    const dte = new Date(t[i]);
    const ym = `${dte.getUTCFullYear()}-${String(dte.getUTCMonth() + 1).padStart(2, "0")}`;
    monthly.set(ym, (monthly.get(ym) ?? 1) * (1 + ret[i]));
  }
  const months = Array.from(monthly.values());
  const pctPositive = months.length ? months.filter((g) => g > 1).length / months.length : 0;
  const years = n / ppy;
  const totalRet = eq - 1;
  const cagr = years > 0.2 && eq > 0 ? Math.pow(eq, 1 / years) - 1 : 0;
  return { sharpe, maxDD, pctPositive, equity: eqOut, totalRet, cagr, months: months.length };
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
  const scaleT = tfScale(primary.tf);
  const sealI = indexOfTs(primary.t, g.sealTs); // first sealed index
  const devEndI = sealI - 1;
  if (devEndI < Math.floor(opts.ppy * 0.6)) throw new Error("not enough pre-seal data");

  // ---- S0 static ----------------------------------------------------------
  let started = t0();
  const errors = validateStrategy(doc);
  if (errors.length) return fail("S0-static", errors.join("; "), started);
  stages.push({ stage: "S0-static", passed: true, durationMs: Date.now() - started });

  // ---- S2 train fit (first 70% of pre-seal data) --------------------------
  started = t0();
  const trainEndI = Math.floor(devEndI * 0.7);
  const fit = tune(doc, primary, opts, { startI: 1, endI: trainEndI }, adaptiveTrials(doc, 50), 11);
  metrics.trainSharpe = fit.sharpe;
  const years = trainEndI / opts.ppy;
  const tradesPerYear = fit.trades / Math.max(0.1, years);
  const minTradesYr = Math.ceil(floors.trainMinTradesPerYear * scaleT);
  if (fit.sharpe < floors.trainMinSharpe) return fail("S2-train", `train sharpe ${fit.sharpe.toFixed(2)} < ${floors.trainMinSharpe}`, started, fit);
  if (tradesPerYear < minTradesYr) return fail("S2-train", `${tradesPerYear.toFixed(0)} trades/yr < ${minTradesYr} (tf ${primary.tf})`, started, fit);
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
  const s3Fail =
    wf.windows.length < 12 ? `only ${wf.windows.length} WF windows`
    : wf.pooledSharpe < floors.wfMinMeanSharpe ? `OOS pooled sharpe ${wf.pooledSharpe.toFixed(2)} < ${floors.wfMinMeanSharpe}`
    : wf.pctPositive < floors.wfMinPctPositive ? `${(wf.pctPositive * 100).toFixed(0)}% positive months < ${floors.wfMinPctPositive * 100}%`
    : wf.worstWindowRet < floors.wfWorstMonth ? `worst month ${(wf.worstWindowRet * 100).toFixed(1)}% < ${floors.wfWorstMonth * 100}%`
    : wf.pooledMaxDD < floors.wfMaxDD ? `OOS maxDD ${(wf.pooledMaxDD * 100).toFixed(0)}%`
    : null;
  if (s3Fail) {
    // backfill full-period stats + curve so the tournament ranks the fallen on real numbers
    const fb = wf.windows.length >= 4 ? medianParams(doc, wf) : fit.params;
    const fullQ = runBacktest(doc, primary, fb, opts, { startI: 1, endI: devEndI });
    metrics.fullSharpe = fullQ.metrics.sharpe;
    metrics.fullSortino = fullQ.metrics.sortino;
    metrics.fullMaxDD = fullQ.metrics.maxDD;
    metrics.fullCagr = fullQ.metrics.cagr;
    metrics.winRate = fullQ.metrics.winRate;
    metrics.fullTrades = fullQ.metrics.trades;
    metrics.exposure = fullQ.metrics.exposure;
    curves.full = downsampleCurve(primary.t, fullQ.equity, 1, devEndI, 300);
    return fail("S3-walkforward", s3Fail, started, summarizeWf(wf));
  }
  stages.push({ stage: "S3-walkforward", passed: true, durationMs: Date.now() - started, detail: summarizeWf(wf) });
  g.log?.(`S3 pass oosSharpe=${wf.pooledSharpe.toFixed(2)} pos=${(wf.pctPositive * 100).toFixed(0)}%`);

  // ---- S4 cross-symbol generalization + DEPLOYED-PORTFOLIO floors ----------
  // The strategy is paper-traded equal-weight across the universe, so the
  // binding consistency/Sharpe floors apply to that portfolio (all returns OOS
  // from re-tuned walk-forwards). Diversification earns score honestly here.
  started = t0();
  let positive = 1; // primary already positive by S3
  const perSymbol: Record<string, number> = { [primary.symbol]: wf.pooledSharpe };
  const portStreams: { t: Float64Array; ret: Float64Array }[] = [{ t: wf.pooledT, ret: wf.pooledRet }];
  for (const other of g.others) {
    const oOpts = optsFor(other.symbol, other.tf);
    const samePane = other.tf === primary.tf;
    const owf = walkForward(doc, other, oOpts, { trainMonths: 12, stepMonths: samePane ? 1 : 2, tuneTrials: 25, endTs: g.sealTs });
    perSymbol[`${other.symbol}@${other.tf}`] = owf.pooledSharpe;
    if (owf.pooledSharpe > 0 && owf.pctPositive >= 0.5) positive++;
    if (samePane) portStreams.push({ t: owf.pooledT, ret: owf.pooledRet });
  }
  metrics.crossSymbolPositive = positive;
  if (positive < floors.crossSymbolMinPositive) return fail("S4-cross-symbol", `WF-positive on ${positive}/${g.others.length + 1} symbols < ${floors.crossSymbolMinPositive}`, started, perSymbol);

  const port = mergePortfolio(portStreams);
  const ps = seriesStats(port.ret, port.t, opts.ppy);
  metrics.portOosSharpe = ps.sharpe;
  metrics.portPctPositive = ps.pctPositive;
  metrics.portMaxDD = ps.maxDD;
  curves.port = downsampleCurve(port.t, ps.equity, 0, port.t.length - 1, 240);
  if (ps.sharpe < floors.portMinSharpe) return fail("S4-portfolio", `portfolio OOS sharpe ${ps.sharpe.toFixed(2)} < ${floors.portMinSharpe}`, started, { ...perSymbol, portfolio: ps.sharpe });
  if (ps.pctPositive < floors.portMinPctPositive) return fail("S4-portfolio", `portfolio ${(ps.pctPositive * 100).toFixed(0)}% positive months < ${floors.portMinPctPositive * 100}%`, started, { ...perSymbol, portfolio: ps.sharpe, pctPositive: ps.pctPositive });
  stages.push({ stage: "S4-cross-symbol", passed: true, durationMs: Date.now() - started, detail: { ...perSymbol, portfolioSharpe: ps.sharpe, portfolioPctPositive: ps.pctPositive, portfolioMaxDD: ps.maxDD } });
  g.log?.(`S4 pass positive=${positive} portfolio=${ps.sharpe.toFixed(2)}`);

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

  // composite is keyed to the DEPLOYED portfolio; sealed (also portfolio) adds 0.3 later
  metrics.composite = 0.5 * (metrics.portOosSharpe ?? 0) + 0.2 * (metrics.fullSharpe ?? 0);
  return { passed: true, stages, metrics, bestParams: finalParams, curves };
}

/** S6 sealed holdout math on the DEPLOYED equal-weight portfolio (one-shot
 *  enforcement lives in the task layer). universeBars = all same-tf symbols. */
export function evaluateSealed(
  doc: StrategyDoc, universeBars: Bars[], params: Record<string, number>, sealTs: number, floors: GateFloors,
): { passed: boolean; reason?: string; sharpe: number; ret: number; maxDD: number; cagr: number; trades: number; curve: Curve } {
  const ppy = PPY[universeBars[0].tf] ?? 8760;
  let trades = 0;
  const streams: { t: Float64Array; ret: Float64Array }[] = [];
  for (const bars of universeBars) {
    const opts = optsFor(bars.symbol, bars.tf);
    const sealI = indexOfTs(bars.t, sealTs);
    const endI = bars.t.length - 1;
    if (endI - sealI < 100) continue;
    const warmStart = Math.max(1, sealI - 1000);
    const res = runBacktest(doc, bars, params, opts, { startI: warmStart, endI });
    const t = new Float64Array(endI - sealI + 1);
    const r = new Float64Array(endI - sealI + 1);
    for (let i = sealI; i <= endI; i++) { t[i - sealI] = bars.t[i]; r[i - sealI] = res.ret[i]; }
    streams.push({ t, ret: r });
    for (const tr of res.trades) if (tr.entryI >= sealI) trades++;
  }
  if (!streams.length) return { passed: false, reason: "no sealed data", sharpe: 0, ret: 0, maxDD: 0, cagr: 0, trades: 0, curve: { t: [], eq: [] } };
  const port = mergePortfolio(streams);
  const ps = seriesStats(port.ret, port.t, ppy);
  const curve = downsampleCurve(port.t, ps.equity, 0, port.t.length - 1, 150);
  const base = { sharpe: ps.sharpe, ret: ps.totalRet, maxDD: ps.maxDD, cagr: ps.cagr, trades, curve };
  const minTrades = Math.max(3, Math.ceil(floors.sealedMinTrades * tfScale(universeBars[0].tf)));
  if (trades < minTrades) return { passed: false, reason: `${trades} sealed trades < ${minTrades}`, ...base };
  if (ps.sharpe < floors.sealedMinSharpe) return { passed: false, reason: `sealed portfolio sharpe ${ps.sharpe.toFixed(2)} < ${floors.sealedMinSharpe}`, ...base };
  if (ps.totalRet <= 0) return { passed: false, reason: `sealed return ${(ps.totalRet * 100).toFixed(1)}% <= 0`, ...base };
  if (ps.maxDD < floors.sealedMaxDD) return { passed: false, reason: `sealed maxDD ${(ps.maxDD * 100).toFixed(0)}%`, ...base };
  return { passed: true, ...base };
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
