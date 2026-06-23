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
import { adaptiveTrials, tune, tuneWithConfigs, type CoSymbol } from "./tune";
import { walkForward, walkForwardPurged, type WfReport } from "./walkforward";
import { validateStrategy } from "./dsl";
import { computePbo, paramStability, suggestEmbargo } from "./rigor";
import { computeCapacity } from "./capacity";
import { classifyRegimes, regimeBreakdown } from "./regime";
import { informationCoefficient, forwardReturns } from "./ic";
import { buildSignalMatrix, usedSignals, hasData } from "./signals";
import { DEFAULT_FEE_BPS, SLIP_BPS, PPY, tfScale, type Bars, type Expr, type GateFloors, type StrategyDoc } from "./types";

/** Largest indicator lookback in bars, resolving param-valued periods. Used to
 *  size the purge window + embargo for the leakage-cleaned WF (shadow). */
export function maxIndicatorLookback(doc: StrategyDoc, params: Record<string, number>): number {
  let max = 1;
  const visit = (e: Expr | undefined) => {
    if (!e || typeof e !== "object") return;
    const n = e as Record<string, unknown>;
    const p = n.period as Record<string, unknown> | undefined;
    if (p) {
      let v = 0;
      if (p.op === "const") v = Number(p.value);
      else if (p.op === "param") v = Number(params[String(p.name)] ?? doc.params?.[String(p.name)]?.default ?? 0);
      if (Number.isFinite(v) && v > max) max = Math.ceil(v);
    }
    for (const k of ["src", "period", "a", "b"]) visit(n[k] as Expr | undefined);
  };
  for (const e of [doc.longEntry, doc.longExit, doc.shortEntry, doc.shortExit]) visit(e);
  return max;
}

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
    // ---- SHADOW-RIGOR metrics (computed, NOT bound as gates) ----
    /** Feature 1: probability of backtest overfitting (CSCV/PBO) on the tuner's configs */
    pbo?: number;
    /** Feature 1: true if PBO proxy (single-strategy perturbations) was used */
    pboProxy?: boolean;
    /** Feature 1: purged+embargoed walk-forward pooled OOS Sharpe (leakage-cleaned) */
    wfPurgedSharpe?: number;
    /** Feature 2: parameter-stability / plateau score in [0,1] */
    paramStability?: number;
    /** Feature 4: per-regime annualized Sharpe of the deployed portfolio OOS returns */
    regimeSharpes?: Record<string, number>;
    /** Feature 4: min Sharpe across well-populated regimes */
    regimeMinSharpe?: number;
    /** Feature 4: >80% of positive PnL came from one regime */
    pnlConcentration?: boolean;
    // ---- WAVE-2 SHADOW metrics (computed, NOT bound as gates) ----
    /** Feature B: capacity in USD — max AUM where net Sharpe >= the floor */
    capacityUsd?: number;
    /** Feature B: net Sharpe at the reference AUM (default $100k) after sqrt-impact */
    impactAdjustedSharpe?: number;
    /** Feature B: frictionless (base-cost) Sharpe used as the capacity baseline */
    capFrictionlessSharpe?: number;
    /** Feature A: marginal book-Sharpe lift of this candidate vs the current book
     *  (filled at the BATCH level in process.ts, not here; placeholder) */
    marginalBookSharpe?: number;
    /** Feature A: max pairwise corr of this candidate to current book members */
    maxBookCorr?: number;
    /** Feature A: shadow flag — would this candidate be admitted to the book? */
    bookQualifies?: boolean;
    // ---- WAVE-3a SHADOW: signal-IC research ----
    /** mean IC-IR of the signals this candidate actually uses (predictive power proxy) */
    signalIC?: number;
    /** per-used-signal IC-IR over the dev (pre-seal) period */
    signalICByName?: Record<string, number>;
    /** IC label horizon (bars) used for the shadow-IC metric */
    signalICHorizon?: number;
    /** shadow would-fail flags (logged only, never bind promotion) */
    shadowWouldFail?: string[];
  };
  /** deployed-portfolio OOS return stream for batch-level Reality Check (Feature 3); not persisted as-is */
  portfolioOos?: { t: number[]; ret: number[] };
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
  const worstMonth = months.length ? Math.min(...months) - 1 : 0;
  const years = n / ppy;
  const totalRet = eq - 1;
  const cagr = years > 0.2 && eq > 0 ? Math.pow(eq, 1 / years) - 1 : 0;
  return { sharpe, maxDD, pctPositive, worstMonth, equity: eqOut, totalRet, cagr, months: months.length };
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
  /** SHADOW-RIGOR config: compute the extra honesty metrics (never binding).
   *  Omit or {enabled:false} to skip the extra compute entirely. */
  shadowRigor?: ShadowRigorConfig;
  /** CALIBRATION PASS binding config. These CHANGE pass/fail (unlike shadowRigor).
   *  Omit => all default OFF (legacy behavior). */
  binding?: BindingConfig;
}

/** CALIBRATION PASS: gates that NOW change pass/fail (Daniel-approved bindings). */
export interface BindingConfig {
  /** S3/S4 use walkForwardPurged (purge+embargo) instead of the leaky walkForward. */
  purgedWf?: boolean;
  /** reject at/after S5 when CSCV PBO >= pboMax. */
  pbo?: { bind: boolean; max: number; blocks?: number };
  /** reject when a well-populated regime is broken or PnL is regime-concentrated. */
  regime?: { bind: boolean; minObs: number; minSharpe: number; maxPnlConcentration: number };
}

export interface ShadowRigorConfig {
  enabled?: boolean;        // default true when the object is present
  pboBlocks?: number;       // CSCV blocks (default 10)
  pboWarnAt?: number;       // would-fail if pbo >= this (default 0.5)
  stabilityWarnAt?: number; // would-fail if stability < this (default 0.4)
  regimeMinObs?: number;    // min obs for a regime bucket to count (default 30)
  /** would-fail if any well-populated regime Sharpe < this (default 0) */
  regimeMinSharpeWarnAt?: number;
  /** WAVE-2 Feature B: capacity/impact (shadow). Omit/{enabled:false} to skip. */
  capacity?: {
    enabled?: boolean;
    k?: number;
    capFloorFrac?: number;
    capFloorAbs?: number;
    refAumUsd?: number;
    advWindow?: number;
  };
}

export function runGauntlet(g: GauntletInputs): GauntletReport {
  const stages: StageOutcome[] = [];
  const metrics: GauntletReport["metrics"] = {};
  const t0 = () => Date.now();
  const curves: GauntletReport["curves"] = {};
  // BOOK-GATE SUPPORT: once S4 builds the deployed-portfolio OOS stream we carry
  // it so even a candidate that FAILS the standalone S5 hurdle still exposes its
  // OOS stream — the book-marginal gate evaluates these as candidate book sleeves
  // (a genuinely-positive 0.7-0.9 sleeve is a good book component even if it fails
  // 1.9 standalone). Pre-S4 failures carry nothing (no portfolio yet).
  let portCarry: { t: number[]; ret: number[] } | undefined;
  const fail = (stage: string, reason: string, started: number, detail?: unknown): GauntletReport => {
    stages.push({ stage, passed: false, reason, detail, durationMs: Date.now() - started });
    return { passed: false, failedStage: stage, failedReason: reason, stages, metrics, curves, portfolioOos: portCarry };
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

  // ---- CALIBRATION PASS: walk-forward selector (purged+embargoed is binding) --
  // The purge window = the strategy's largest indicator lookback (resolved at the
  // train-fit params); the embargo additionally skips ~1% of bars. With this on,
  // the BINDING S3/S4 floors reference the leakage-cleaned OOS estimate. Escape
  // hatch: binding.purgedWf=false reverts to the legacy leaky walkForward.
  const usePurged = g.binding?.purgedWf === true;
  const wfLookback = maxIndicatorLookback(doc, fit.params);
  const wfEmbargo = suggestEmbargo(devEndI, wfLookback);

  // ---- MULTI-SYMBOL TUNING SUBSET (root fix, 2026-06-23) -------------------
  // Param selection inside the S3/S4 re-tuning now optimises for cross-symbol
  // robustness, not BTC-primary alone, so params are no longer BTC-overfit by
  // construction (cross-symbol used to be seen only at S4 — too late to steer).
  // COMPUTE: each tune eval runs ~(1+|subset|) backtests, so we tune on a 2-symbol
  // SAME-TF subset (3 series/eval) and let S4 validate on ALL 5 — keeping cost ~3x
  // per eval rather than 5-6x. We also trim the tune-trial budget (S3 40->26, S4
  // 25->16) so net wall-time stays ~1.5-2x the old single-symbol cost instead of
  // 3x. Subset = the first up-to-2 same-tf "others"; if none exist (no panel),
  // cosymbols is empty and behaviour is exactly the legacy single-symbol tune.
  const sameTfOthers = g.others.filter((b) => b.tf === primary.tf);
  const tuneSubset: CoSymbol[] = sameTfOthers.slice(0, 2).map((b) => ({ bars: b, opts: optsFor(b.symbol, b.tf) }));
  const MS_TUNE = tuneSubset.length > 0;
  g.log?.(`multi-symbol tuning: ${MS_TUNE ? `${tuneSubset.length + 1} symbols (primary + ${tuneSubset.length} subset)` : "off (no same-tf panel)"}`);

  // runWf: when `co` is passed, the per-window re-tune selects cross-symbol-robust
  // params; the WF is still SCORED on its own `bars` (single-symbol OOS), so every
  // S3/S4 floor reads the same metric as before — only param SELECTION changed.
  const runWf = (bars: Bars, oOpts: ReturnType<typeof optsFor>, c: { trainMonths: number; stepMonths: number; tuneTrials: number; endTs: number }, co?: CoSymbol[]): WfReport =>
    usePurged
      ? walkForwardPurged(doc, bars, oOpts, { ...c, purgeWindow: wfLookback, embargo: wfEmbargo, cosymbols: co })
      : walkForward(doc, bars, oOpts, { ...c, cosymbols: co });
  if (usePurged) g.log?.(`WF=purged purge=${wfLookback} embargo=${wfEmbargo}`);

  // ---- S3 walk-forward with re-tuning (pre-seal only) ---------------------
  started = t0();
  // S3 tunes the PRIMARY but selects params robust across the subset (multi-symbol).
  const wf = runWf(primary, opts, { trainMonths: 12, stepMonths: 1, tuneTrials: MS_TUNE ? 26 : 40, endTs: g.sealTs }, tuneSubset);
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
    // Each per-symbol WF also selects cross-symbol-robust params: tune `other`
    // against the PRIMARY + one same-tf peer (excluding `other` itself), so a
    // per-symbol WF can't converge to an `other`-only overfit. Cross-tf panes get
    // an empty subset (different ppy/window scaling) => legacy single-symbol tune.
    const oCo: CoSymbol[] = samePane
      ? [{ bars: primary, opts }, ...sameTfOthers.filter((b) => b.symbol !== other.symbol).slice(0, 1).map((b) => ({ bars: b, opts: optsFor(b.symbol, b.tf) }))]
      : [];
    const owf = runWf(other, oOpts, { trainMonths: 12, stepMonths: samePane ? 1 : 2, tuneTrials: (samePane && oCo.length) ? 16 : 25, endTs: g.sealTs }, oCo);
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
  // carry the raw deployed-portfolio OOS stream so S4-portfolio/S5+ failures still
  // expose it to the book-marginal gate (a weak-but-uncorrelated sleeve is a valid
  // book candidate even though it fails the standalone hurdle). Array<-Float64.
  portCarry = { t: Array.from(port.t, Number), ret: Array.from(port.ret, Number) };
  if (ps.sharpe < floors.portMinSharpe) return fail("S4-portfolio", `portfolio OOS sharpe ${ps.sharpe.toFixed(2)} < ${floors.portMinSharpe}`, started, { ...perSymbol, portfolio: ps.sharpe });
  if (ps.pctPositive < floors.portMinPctPositive) return fail("S4-portfolio", `portfolio ${(ps.pctPositive * 100).toFixed(0)}% positive months < ${floors.portMinPctPositive * 100}%`, started, { ...perSymbol, portfolio: ps.sharpe, pctPositive: ps.pctPositive });
  if (ps.worstMonth < floors.portWorstMonth) return fail("S4-portfolio", `portfolio worst month ${(ps.worstMonth * 100).toFixed(1)}% < ${floors.portWorstMonth * 100}%`, started, { ...perSymbol, portfolio: ps.sharpe, worstMonth: ps.worstMonth });
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
  const d = dsr(full.ret, 2, devEndI, Math.max(g.nTrialsTotal, 10), opts.ppy);
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

  // ---- S5c BINDING RIGOR (CALIBRATION PASS) — PBO + regime are REAL gates -----
  // These were shadow-logged in Waves 1-3; Daniel chose to BIND them. They run
  // independently of the shadow block (which may be disabled) and FAIL the
  // candidate when breached. Results are stashed in `metrics` so the shadow block
  // below reuses them instead of recomputing.
  const bind = g.binding;
  // (2) PBO via CSCV over the tuner's REAL configuration set on the train slice
  // (where overfitting is decided), evaluated across the dev range. Falls back to
  // a labelled single-strategy proxy if the config set is degenerate.
  if (bind?.pbo?.bind) {
    started = t0();
    const trainEndForPbo = Math.floor(devEndI * 0.7);
    const tuned = tuneWithConfigs(doc, primary, opts, { startI: 1, endI: trainEndForPbo }, adaptiveTrials(doc, 50), 11);
    const realConfigs = dedupeConfigs(tuned.configs.map((c) => c.params));
    const nBlocks = bind.pbo.blocks ?? 10;
    const pbo = realConfigs.length >= 4
      ? computePbo(doc, primary, opts, realConfigs, { startI: 1, endI: devEndI }, { nBlocks, proxy: false })
      : computePbo(doc, primary, opts, proxyConfigGrid(doc, finalParams), { startI: 1, endI: devEndI }, { nBlocks, proxy: true });
    metrics.pbo = pbo.pbo;
    metrics.pboProxy = pbo.proxy;
    if (pbo.pbo >= bind.pbo.max) return fail("S5c-pbo", `PBO ${pbo.pbo.toFixed(2)}${pbo.proxy ? "(proxy)" : ""} >= ${bind.pbo.max} (backtest-overfitting)`, started, { pbo: pbo.pbo, proxy: pbo.proxy, nSplits: pbo.nSplits, nConfigs: pbo.nConfigs });
    stages.push({ stage: "S5c-pbo", passed: true, durationMs: Date.now() - started, detail: { pbo: pbo.pbo, proxy: pbo.proxy } });
    g.log?.(`S5c-pbo pass pbo=${pbo.pbo.toFixed(2)}${pbo.proxy ? "(proxy)" : ""} < ${bind.pbo.max}`);
  }
  // (3) Regime robustness on the deployed-portfolio OOS returns: reject if any
  // well-populated regime is broken (Sharpe < minSharpe) or positive PnL is
  // concentrated in one regime (> 0.8). Labels come from PRIMARY price/vol only.
  if (bind?.regime?.bind) {
    started = t0();
    const regimeLabels = labelsForTimestamps(primary, port.t);
    const rb = regimeBreakdown(port.ret, regimeLabels, opts.ppy, bind.regime.minObs);
    metrics.regimeSharpes = rb.sharpeByName;
    metrics.regimeMinSharpe = Number.isFinite(rb.minWellPopulatedSharpe) ? rb.minWellPopulatedSharpe : undefined;
    metrics.pnlConcentration = rb.pnlConcentration;
    if (Number.isFinite(rb.minWellPopulatedSharpe) && rb.minWellPopulatedSharpe < bind.regime.minSharpe) {
      return fail("S5c-regime", `regime "${worstRegimeName(rb)}" Sharpe ${rb.minWellPopulatedSharpe.toFixed(2)} < ${bind.regime.minSharpe}`, started, { sharpeByName: rb.sharpeByName });
    }
    if (rb.pnlConcentration) {
      return fail("S5c-regime", `PnL concentrated in ${rb.dominant?.name} (${((rb.dominant?.share ?? 0) * 100).toFixed(0)}% > ${(bind.regime.maxPnlConcentration * 100).toFixed(0)}%)`, started, { dominant: rb.dominant, sharpeByName: rb.sharpeByName });
    }
    stages.push({ stage: "S5c-regime", passed: true, durationMs: Date.now() - started, detail: { sharpeByName: rb.sharpeByName, minSharpe: rb.minWellPopulatedSharpe } });
    g.log?.(`S5c-regime pass minSharpe=${metrics.regimeMinSharpe?.toFixed(2) ?? "n/a"} conc=${rb.pnlConcentration ? "Y" : "N"}`);
  }

  // ---- SHADOW-RIGOR (Features 1/2/4) — COMPUTED, NEVER BINDING ------------
  // Runs only on candidates that survived the real gauntlet, on the deployed
  // portfolio / final deployment params. Emits a log line + would-fail flags;
  // does NOT change any pass/fail decision or the composite score. Expose the
  // deployed-portfolio OOS stream so process.ts can run batch-level Reality
  // Check (Feature 3) across the cycle's S4+ survivors.
  const portfolioOos = { t: port.t, ret: port.ret };
  const sr = g.shadowRigor;
  if (sr && sr.enabled !== false) {
    try {
      const wouldFail: string[] = [];
      // Feature 1: PBO via CSCV over the tuner's real configuration set, on the
      // train slice (where overfitting is decided). Falls back to a labelled
      // single-strategy proxy if the config set is degenerate.
      // Reuse the binding-gate PBO when present (avoids an expensive recompute);
      // otherwise compute it here for the shadow would-fail flag.
      let pboProxyForLog = metrics.pboProxy ?? false;
      if (metrics.pbo === undefined) {
        const trainEndForPbo = Math.floor(devEndI * 0.7);
        const tuned = tuneWithConfigs(doc, primary, opts, { startI: 1, endI: trainEndForPbo }, adaptiveTrials(doc, 50), 11);
        const realConfigs = dedupeConfigs(tuned.configs.map((c) => c.params));
        const pbo = realConfigs.length >= 4
          ? computePbo(doc, primary, opts, realConfigs, { startI: 1, endI: devEndI }, { nBlocks: sr.pboBlocks ?? 10, proxy: false })
          : computePbo(doc, primary, opts, proxyConfigGrid(doc, finalParams), { startI: 1, endI: devEndI }, { nBlocks: sr.pboBlocks ?? 10, proxy: true });
        metrics.pbo = pbo.pbo;
        metrics.pboProxy = pbo.proxy;
        pboProxyForLog = pbo.proxy;
      }
      if ((metrics.pbo ?? 0) >= (sr.pboWarnAt ?? 0.5)) wouldFail.push(`PBO ${(metrics.pbo ?? 0).toFixed(2)} >= ${(sr.pboWarnAt ?? 0.5)}`);

      // Feature 1b: purged+embargoed WF Sharpe (leakage-cleaned re-estimate)
      const lookback = maxIndicatorLookback(doc, finalParams);
      const embargo = suggestEmbargo(devEndI, lookback);
      const wfp = walkForwardPurged(doc, primary, opts, { trainMonths: 12, stepMonths: 1, tuneTrials: 40, endTs: g.sealTs, purgeWindow: lookback, embargo });
      metrics.wfPurgedSharpe = wfp.pooledSharpe;

      // Feature 2: parameter stability / plateau around the deployment params
      const stab = paramStability(doc, primary, opts, finalParams, { startI: 1, endI: devEndI });
      metrics.paramStability = stab.stability;
      if (stab.stability < (sr.stabilityWarnAt ?? 0.4)) wouldFail.push(`stability ${stab.stability.toFixed(2)} < ${(sr.stabilityWarnAt ?? 0.4)}`);

      // Feature 4: regime-conditional robustness on the deployed portfolio OOS
      // returns. Classify regimes from the PRIMARY closes restricted to the
      // portfolio timestamps (price+vol only).
      // Reuse binding-gate regime metrics when present; else compute for the flag.
      if (metrics.regimeSharpes === undefined) {
        const regimeLabels = labelsForTimestamps(primary, port.t);
        const rb = regimeBreakdown(port.ret, regimeLabels, opts.ppy, sr.regimeMinObs ?? 30);
        metrics.regimeSharpes = rb.sharpeByName;
        metrics.regimeMinSharpe = Number.isFinite(rb.minWellPopulatedSharpe) ? rb.minWellPopulatedSharpe : undefined;
        metrics.pnlConcentration = rb.pnlConcentration;
      }
      const regimeWarnAt = sr.regimeMinSharpeWarnAt ?? 0;
      if (metrics.regimeMinSharpe !== undefined && metrics.regimeMinSharpe < regimeWarnAt) wouldFail.push(`regime minSharpe ${metrics.regimeMinSharpe.toFixed(2)} < ${regimeWarnAt}`);
      if (metrics.pnlConcentration) wouldFail.push(`PnL regime-concentrated`);

      // WAVE-2 Feature B: capacity & sqrt-impact on the PRIMARY symbol with the
      // deployment params, over the pre-seal dev range. Shadow/log only.
      const capCfg = sr.capacity;
      let capLog = "";
      if (capCfg && capCfg.enabled !== false) {
        const cap = computeCapacity(doc, primary, finalParams, opts, { startI: 1, endI: devEndI }, {
          k: capCfg.k, capFloorFrac: capCfg.capFloorFrac, capFloorAbs: capCfg.capFloorAbs,
          refAumUsd: capCfg.refAumUsd, advWindow: capCfg.advWindow,
        });
        metrics.capacityUsd = cap.capacityUsd;
        metrics.impactAdjustedSharpe = cap.impactAdjustedSharpe;
        metrics.capFrictionlessSharpe = cap.frictionlessSharpe;
        capLog = ` | shadow-capacity: capUsd=${fmtUsd(cap.capacityUsd)} impAdjSharpe=${cap.impactAdjustedSharpe.toFixed(2)} frictionless=${cap.frictionlessSharpe.toFixed(2)}${cap.note ? ` (${cap.note})` : ""}`;
      }

      // WAVE-3a Feature 2: shadow signal-IC. Score the IC-IR of the signals THIS
      // candidate actually uses, over forward returns on the pre-seal dev range of
      // the primary symbol. signalIC = mean |IC-IR| of those signals (a "do the
      // inputs predict?" proxy). Skips all-zero/unavailable inputs (no fabrication).
      let icLog = "";
      try {
        const icBars = sliceBars(primary, 0, devEndI);
        const horizon = primary.tf === "1d" ? 5 : primary.tf === "4h" ? 6 : 24; // ~1 day / ~1 day / ~1 day ahead
        const used = usedSignals([doc.longEntry, doc.longExit, doc.shortEntry, doc.shortExit]);
        if (used.length) {
          const matrix = buildSignalMatrix(icBars, used);
          const fwd = forwardReturns(icBars.c, horizon);
          const byName: Record<string, number> = {};
          let sumAbsIR = 0, k = 0;
          for (const sgnl of matrix) {
            if (!hasData(sgnl.values)) continue; // input unavailable on this series — skip honestly
            const ic = informationCoefficient(sgnl.values, fwd, horizon);
            byName[sgnl.name] = Number(ic.icIR.toFixed(3));
            sumAbsIR += Math.abs(ic.icIR); k++;
          }
          if (k > 0) {
            metrics.signalIC = sumAbsIR / k;
            metrics.signalICByName = byName;
            metrics.signalICHorizon = horizon;
            icLog = ` | shadow-ic: meanICIR=${metrics.signalIC.toFixed(2)} h=${horizon} signals=[${Object.entries(byName).map(([n, v]) => `${n}:${v}`).join(" ")}]`;
          }
        }
      } catch (e) { icLog = ` | shadow-ic: ERROR ${e instanceof Error ? e.message.slice(0, 60) : e}`; }

      metrics.shadowWouldFail = wouldFail;
      g.log?.(`shadow-rigor: PBO=${metrics.pbo?.toFixed(2)}${pboProxyForLog ? "(proxy)" : ""} stability=${metrics.paramStability?.toFixed(2)} wfPurged=${metrics.wfPurgedSharpe?.toFixed(2)} regimeMinSharpe=${metrics.regimeMinSharpe?.toFixed(2) ?? "n/a"} conc=${metrics.pnlConcentration ? "Y" : "N"} wouldFail=[${wouldFail.join(" | ")}]${capLog}${icLog}`);
    } catch (e) {
      g.log?.(`shadow-rigor: ERROR ${e instanceof Error ? e.message : e}`);
    }
  }

  // composite is keyed to the DEPLOYED portfolio; sealed (also portfolio) adds 0.3 later
  metrics.composite = 0.5 * (metrics.portOosSharpe ?? 0) + 0.2 * (metrics.fullSharpe ?? 0);
  return { passed: true, stages, metrics, bestParams: finalParams, curves, portfolioOos };
}

/** distinct configs (by rounded param signature) so CSCV sees real variety. */
function dedupeConfigs(configs: Record<string, number>[]): Record<string, number>[] {
  const seen = new Set<string>();
  const out: Record<string, number>[] = [];
  for (const c of configs) {
    const key = Object.keys(c).sort().map((k) => `${k}:${c[k].toFixed(4)}`).join("|");
    if (!seen.has(key)) { seen.add(key); out.push(c); }
  }
  return out;
}

/** single-strategy PBO proxy: a small grid of ±10/20% perturbations per param. */
function proxyConfigGrid(doc: StrategyDoc, base: Record<string, number>): Record<string, number>[] {
  const keys = Object.keys(doc.params ?? {}).filter((k) => Number.isFinite(base[k]));
  const grid: Record<string, number>[] = [{ ...base }];
  for (const k of keys) {
    for (const d of [-0.2, -0.1, 0.1, 0.2]) {
      const spec = doc.params[k];
      let v = base[k] * (1 + d);
      v = Math.min(spec.max, Math.max(spec.min, v));
      if (spec.int) v = Math.round(v);
      if (v === base[k]) continue;
      grid.push({ ...base, [k]: v });
    }
  }
  return dedupeConfigs(grid);
}

/** Regime labels for `primary`, restricted/aligned to the portfolio timestamps. */
function labelsForTimestamps(primary: Bars, portT: number[]): Int8Array {
  const cls = classifyRegimes(primary.c, { volWindow: 48, trendWindow: 96 });
  // map portfolio ts -> primary index (binary search) -> label
  const out = new Int8Array(portT.length).fill(-1);
  for (let i = 0; i < portT.length; i++) {
    const idx = indexOfTs(primary.t, portT[i]);
    if (idx >= 0 && idx < primary.t.length && primary.t[idx] === portT[i]) out[i] = cls.labels[idx];
  }
  return out;
}

/** name of the worst well-populated regime (for the binding-gate fail message). */
function worstRegimeName(rb: ReturnType<typeof regimeBreakdown>): string {
  let worst = "n/a", v = Infinity;
  for (const [name, sh] of Object.entries(rb.sharpeByName)) if (sh < v) { v = sh; worst = name; }
  return worst;
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

/** compact USD formatter for shadow log lines ($1.2M, $500k, $750). */
function fmtUsd(x: number): string {
  if (!Number.isFinite(x)) return "n/a";
  if (x >= 1e9) return `$${(x / 1e9).toFixed(1)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(0)}k`;
  return `$${x.toFixed(0)}`;
}

export function sliceBars(bars: Bars, fromI: number, toI: number): Bars {
  const lo = bars.t[fromI], hi = bars.t[toI];
  const sliceStamps = (st?: number[], sv?: number[]): { t?: number[]; v?: number[] } => {
    if (!st || !sv) return {};
    const t: number[] = [], v: number[] = [];
    for (let i = 0; i < st.length; i++) if (st[i] >= lo && st[i] <= hi) { t.push(st[i]); v.push(sv[i]); }
    return { t, v };
  };
  const oiS = sliceStamps(bars.oiT, bars.oiV);
  const lsrS = sliceStamps(bars.lsrT, bars.lsrR);
  return {
    symbol: bars.symbol, tf: bars.tf,
    t: bars.t.slice(fromI, toI + 1), o: bars.o.slice(fromI, toI + 1), h: bars.h.slice(fromI, toI + 1),
    l: bars.l.slice(fromI, toI + 1), c: bars.c.slice(fromI, toI + 1), v: bars.v.slice(fromI, toI + 1),
    fundingT: bars.fundingT?.filter((t) => t >= lo && t <= hi),
    fundingR: bars.fundingT ? bars.fundingR?.filter((_, i) => (bars.fundingT as number[])[i] >= lo && (bars.fundingT as number[])[i] <= hi) : undefined,
    // WAVE-3a: carry crypto-native series through slicing (basis is bar-aligned; oi/lsr are stamps)
    spotC: bars.spotC ? bars.spotC.slice(fromI, toI + 1) : undefined,
    oiT: oiS.t, oiV: oiS.v, lsrT: lsrS.t, lsrR: lsrS.v,
  };
}
