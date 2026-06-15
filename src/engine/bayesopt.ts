// WAVE-3b: Bayesian hyperparameter search (TPE) — a sample-efficient
// alternative to the random-search + hill-climb tuner in tune.ts.
//
// Tree-structured Parzen Estimator: instead of modelling p(objective | params),
// TPE models p(params | objective) by splitting evaluated points into a "good"
// set (top quantile) and a "bad" set, fitting a kernel-density estimate to each
// per dimension, and proposing the candidate that maximizes the ratio l(x)/g(x)
// — which is monotone in Expected Improvement. Cheap, gradient-free, handles
// mixed continuous/integer bounded spaces, and warm-starts from priors.
//
// Interface-compatible with tune()/tuneWithConfigs: same args, returns a
// TuneResult plus `configs` = EVERY evaluated point (the Wave-1 CSCV/PBO probe
// consumes this). Wired in behind the DEFAULT-FALSE `bayesTuning` flag; when off,
// the legacy tuner in tune.ts is used unchanged.

import { runBacktest } from "./backtest";
import { mulberry32 } from "./stats";
import { objective, type TuneResult } from "./tune";
import type { BacktestOpts, Bars, StrategyDoc } from "./types";

interface Dim {
  name: string;
  min: number;
  max: number;
  int: boolean;
  prior: number; // warm-start mean (the param default), clamped into bounds
}

export interface BayesConfig {
  /** fraction of best points used as the "good" set l(x) (Hyperopt default ~0.25) */
  gamma?: number;
  /** candidate draws per ask, scored by l/g; the best becomes the next eval */
  nCandidates?: number;
  /** random/Sobol-like seeding evals before the model kicks in (exploration) */
  nStartup?: number;
  /** KDE bandwidth as a fraction of each dimension's range */
  bandwidthFrac?: number;
}

const DEFAULTS: Required<BayesConfig> = {
  gamma: 0.25,
  nCandidates: 24,
  nStartup: 8,
  bandwidthFrac: 0.12,
};

function dimsOf(doc: StrategyDoc): Dim[] {
  return Object.entries(doc.params ?? {}).map(([name, p]) => ({
    name,
    min: p.min,
    max: p.max,
    int: !!p.int,
    prior: Math.min(p.max, Math.max(p.min, p.default)),
  }));
}

function clampDim(d: Dim, v: number): number {
  let x = Math.min(d.max, Math.max(d.min, v));
  if (d.int) x = Math.round(x);
  return x;
}

// Truncated-Gaussian sample around `mu` with stdev `sigma`, reflected into bounds.
function sampleTruncGauss(d: Dim, mu: number, sigma: number, rng: () => number): number {
  // Box-Muller
  let u = 0, w = 0;
  while (u === 0) u = rng();
  while (w === 0) w = rng();
  const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
  return clampDim(d, mu + g * sigma);
}

// Gaussian KDE density of value `x` under a set of observation centres.
function kde(x: number, centres: number[], bandwidth: number): number {
  if (centres.length === 0) return 1e-9;
  const h = Math.max(bandwidth, 1e-9);
  let s = 0;
  for (const c of centres) {
    const z = (x - c) / h;
    s += Math.exp(-0.5 * z * z);
  }
  return s / (centres.length * h * Math.sqrt(2 * Math.PI)) + 1e-12;
}

export interface BayesOptArgs {
  doc: StrategyDoc;
  /** objective to MAXIMIZE; gets a full param vector, returns {objective, sharpe, trades} */
  evaluate: (params: Record<string, number>) => { objective: number; sharpe: number; trades: number };
  nTrials: number;
  seed?: number;
  cfg?: BayesConfig;
}

export interface BayesOptResult extends TuneResult {
  configs: { params: Record<string, number>; objective: number; sharpe: number }[];
}

/**
 * Core TPE loop over an arbitrary objective. Returns the best point AND every
 * evaluated config. Warm-starts the first eval at the priors (param defaults),
 * seeds nStartup quasi-random points, then for each subsequent ask proposes the
 * candidate maximizing l(x)/g(x) (TPE's EI-proportional acquisition).
 */
export function bayesOptimize(args: BayesOptArgs): BayesOptResult {
  const { doc, evaluate } = args;
  const cfg = { ...DEFAULTS, ...(args.cfg ?? {}) };
  const dims = dimsOf(doc);
  const rng = mulberry32(args.seed ?? 11);
  const configs: { params: Record<string, number>; objective: number; sharpe: number }[] = [];
  type Pt = { params: Record<string, number>; objective: number; sharpe: number; trades: number };
  const history: Pt[] = [];

  // zero-param strategies: a single default evaluation (mirror tune()).
  if (dims.length === 0) {
    const r = evaluate({});
    configs.push({ params: {}, objective: r.objective, sharpe: r.sharpe });
    return { params: {}, objective: r.objective, sharpe: r.sharpe, trades: r.trades, configs };
  }

  const evalAt = (params: Record<string, number>): void => {
    const r = evaluate(params);
    history.push({ params, objective: r.objective, sharpe: r.sharpe, trades: r.trades });
    configs.push({ params: { ...params }, objective: r.objective, sharpe: r.sharpe });
  };

  const nTrials = Math.max(1, args.nTrials);

  for (let t = 0; t < nTrials; t++) {
    let params: Record<string, number>;
    if (t === 0) {
      // warm start: evaluate the priors first (the human/parent's chosen defaults)
      params = Object.fromEntries(dims.map((d) => [d.name, clampDim(d, d.prior)]));
    } else if (t < cfg.nStartup) {
      // startup exploration: jittered draws around priors + uniform coverage.
      // Mixing prior-centred and uniform keeps early coverage broad (explore
      // BEFORE exploit) so the model isn't anchored to the prior basin.
      params = Object.fromEntries(dims.map((d) => {
        if (rng() < 0.5) {
          return [d.name, sampleTruncGauss(d, d.prior, (d.max - d.min) * 0.35, rng)];
        }
        return [d.name, clampDim(d, d.min + (d.max - d.min) * rng())];
      }));
    } else {
      params = tpeAsk(dims, history, cfg, rng);
    }
    evalAt(params);
  }

  // best = argmax objective over everything evaluated (history is non-empty since
  // nTrials >= 1). Reduce keeps it explicit and avoids closure-narrowing issues.
  const b = history.reduce((acc, p) => (p.objective > acc.objective ? p : acc), history[0]);
  return { params: b.params, objective: b.objective, sharpe: b.sharpe, trades: b.trades, configs };
}

/**
 * TPE acquisition: split history into good (top gamma by objective) and bad,
 * then per dimension draw candidates from the good-set KDE and score each whole
 * candidate by sum_d log( l_d(x)/g_d(x) ). Return the argmax — the point most
 * likely "good" and least likely "bad" (∝ Expected Improvement).
 */
function tpeAsk(
  dims: Dim[],
  history: { params: Record<string, number>; objective: number }[],
  cfg: Required<BayesConfig>,
  rng: () => number,
): Record<string, number> {
  // sort descending by objective; good = top gamma (at least 1), bad = rest.
  const sorted = [...history].sort((a, b) => b.objective - a.objective);
  const nGood = Math.max(1, Math.floor(cfg.gamma * sorted.length));
  const good = sorted.slice(0, nGood);
  const bad = sorted.slice(nGood);

  // per-dimension observation centres (+ the prior as a pseudo-observation in the
  // good set so the model never fully forgets the warm-start basin).
  const goodC: Record<string, number[]> = {};
  const badC: Record<string, number[]> = {};
  const bw: Record<string, number> = {};
  for (const d of dims) {
    goodC[d.name] = [d.prior, ...good.map((p) => p.params[d.name]).filter(Number.isFinite)];
    badC[d.name] = bad.map((p) => p.params[d.name]).filter(Number.isFinite);
    bw[d.name] = Math.max((d.max - d.min) * cfg.bandwidthFrac, d.int ? 0.5 : 1e-6);
  }

  // draw nCandidates from the GOOD KDE (mixture: pick a random good centre, jitter
  // by the bandwidth), score by l/g, keep the best.
  let bestCand: Record<string, number> | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < cfg.nCandidates; i++) {
    const cand: Record<string, number> = {};
    for (const d of dims) {
      const centres = goodC[d.name];
      const mu = centres[Math.floor(rng() * centres.length)];
      cand[d.name] = sampleTruncGauss(d, mu, bw[d.name], rng);
    }
    let score = 0;
    for (const d of dims) {
      const l = kde(cand[d.name], goodC[d.name], bw[d.name]);
      const g = kde(cand[d.name], badC[d.name].length ? badC[d.name] : [d.prior], bw[d.name]);
      score += Math.log(l) - Math.log(g);
    }
    if (score > bestScore) { bestScore = score; bestCand = cand; }
  }
  return bestCand ?? Object.fromEntries(dims.map((d) => [d.name, clampDim(d, d.prior)]));
}

// --------------------------------------------------- drop-in tuner wrapper
/**
 * Bayesian alternative to tune()/tuneWithConfigs. Same signature as
 * tuneWithConfigs; returns TuneResult + every evaluated config so the PBO probe
 * works identically. Wired behind the DEFAULT-FALSE `bayesTuning` flag in the
 * caller — when off, tune.ts's adaptive random-search + hill-climb runs unchanged.
 */
export function bayesTune(
  doc: StrategyDoc,
  bars: Bars,
  opts: BacktestOpts,
  range: { startI: number; endI: number },
  nTrials = 60,
  seed = 11,
  cfg?: BayesConfig,
): BayesOptResult {
  const evaluate = (params: Record<string, number>) => {
    const res = runBacktest(doc, bars, params, opts, range);
    return {
      objective: objective(res.metrics.sharpe, res.metrics.trades),
      sharpe: res.metrics.sharpe,
      trades: res.metrics.trades,
    };
  };
  return bayesOptimize({ doc, evaluate, nTrials, seed, cfg });
}
