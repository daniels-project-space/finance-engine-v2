// Runtime configuration with safe defaults; overridable via Convex config table.
import { DEFAULT_FLOORS, type GateFloors } from "../engine/types";

export interface AppConfig {
  universe: string[];
  primarySymbol: string;
  tf: string;
  /** ISO date string; data >= sealDate is sealed (S6 one-shot only) */
  sealDate: string;
  historyStart: string;
  floors: GateFloors;
  autoPromote: boolean;
  paperStartEquity: number;
  killSwitch: { dailyDD: number; weeklyDD: number; monthlyDD: number };
  evo: { batchGp: number; batchFresh: number; batchLlm: number; maxCandidatesPerDay: number };
  llmDailyBudgetUsd: number;
  /** SHADOW-RIGOR knobs. `compute` toggles the extra metrics; `bind` is RESERVED
   *  for later and is IGNORED today — none of these ever change pass/fail yet.
   *  Thresholds are the would-fail flag cut points (logged only). */
  shadowRigor: {
    compute: boolean;
    bind: boolean;                 // legacy global flag (still ignored by the gauntlet)
    pboBlocks: number;
    pboWarnAt: number;
    stabilityWarnAt: number;
    regimeMinObs: number;
    regimeMinSharpeWarnAt: number;
    realityCheck: boolean;         // batch-level White RC over S4+ survivors
    rcReps: number;
    rcWarnAt: number;              // family-wise p above which best-candidate would-fail
    // CALIBRATION PASS: PBO is now a BINDING gate when pbo.bind is true. A
    // candidate with CSCV PBO >= pbo.max is rejected at/after S5.
    pbo: { bind: boolean; max: number };
    // CALIBRATION PASS: regime robustness is now a BINDING gate when regime.bind
    // is true. A candidate fails if any regime with >= regime.minObs observations
    // has Sharpe < regime.minSharpe, OR positive-PnL concentration exceeds
    // regime.maxPnlConcentration (the regimeBreakdown concentration flag fires at
    // > 0.8 today; maxPnlConcentration is kept for clarity/forward-compat).
    regime: { bind: boolean; minObs: number; minSharpe: number; maxPnlConcentration: number };
  };
  /** CALIBRATION PASS: walk-forward leakage discipline. When purged is true the
   *  binding S3/S4 path uses walkForwardPurged (purge+embargo) instead of the
   *  leaky walkForward. Escape hatch: set purged:false to revert to the old WF. */
  walkforward: { purged: boolean };
  /** CALIBRATION PASS: IC-steered generation. When true, generation reads the
   *  persisted signal-IC report and biases signal selection (GP grammar + LLM
   *  prompt) toward high-IC signals. Cold-start safe (no report => uniform). */
  icSteering: boolean;
  /** CALIBRATION PASS: book-diversification promotion eligibility. When true a
   *  book-qualifying candidate graduates to `eligible` even without a standalone
   *  composite >= 1.1x champion. The APPROVAL gate is unchanged — champion swaps
   *  on book grounds still wait for Daniel (auto-swap stays standalone-only). */
  bookPromotion: boolean;
  /** WAVE-2 SHADOW knobs. Both blocks are SHADOW-ONLY: computed + logged +
   *  persisted additively, NEVER bound to promotion or the composite.
   *  `enabled:false` skips the extra compute entirely. */
  book: {
    enabled: boolean;
    /** marginal book-Sharpe gain at/above which a candidate qualifies on lift */
    minMarginalSharpe: number;
    /** max pairwise corr under which a positive candidate qualifies as a diversifier */
    maxCorr: number;
    /** BOOK-MARGINAL PROMOTION GATE (bookGate.ts). When `marginalGate` is true, a
     *  candidate that FAILS the standalone S5-DSR hurdle but passes the relaxed
     *  per-sleeve significance AND is marginally book-accretive is routed to
     *  incubation as a BOOK SLEEVE — but ONLY if the whole book then clears the
     *  book-level honesty bar (C). Default FALSE here; we ship it ON via the live
     *  config override as a READY RECEIVER (promotes nothing until a book clears C).
     *  The A/B/C knobs below tune the gate. */
    marginalGate: boolean;
    /** (A) relaxed per-sleeve: bootstrap CI lower bound must exceed this */
    sleeveMinBootLo: number;
    /** (A) relaxed per-sleeve: deflated Sharpe (bootstrap p5) must be >= this */
    sleeveMinDeflated: number;
    /** (C) book-level: book OOS Sharpe must be >= this */
    bookMinSharpe: number;
    /** (C) book-level: book deflated Sharpe (p5) must be >= this */
    bookMinDeflated: number;
    /** (C) book-level: mean |off-diagonal correlation| must be <= this */
    bookMaxMeanCorr: number;
  };
  capacity: {
    enabled: boolean;
    /** square-root impact coefficient k in cost = k*sigma*sqrt(participation) (~0.5-1.0) */
    k: number;
    /** capacity floor as a FRACTION of frictionless Sharpe (e.g. 0.5 = keep >=50%) */
    capFloorFrac: number;
    /** absolute capacity floor; the effective floor is max(abs, frac*frictionless) */
    capFloorAbs: number;
    /** reference AUM (USD) for impactAdjustedSharpe */
    refAumUsd: number;
    /** rolling window (bars) for the ADV notional proxy */
    advWindow: number;
  };
  /** WAVE-3b generation knobs. premiumAnchoredGen flips the LLM lane to the
   *  risk-premium-anchored prompt (mechanism-required). DEFAULT FALSE — the
   *  legacy prompt is the untouched default. Premium TAGGING is always live. */
  generation: {
    premiumAnchoredGen: boolean;
  };
  /** WAVE-3b tuning knobs. bayesTuning swaps the random-search+hill-climb tuner
   *  for the TPE Bayesian optimizer. DEFAULT FALSE — the legacy tuner is the
   *  untouched default. bayes.* are the TPE hyperparameters. */
  tuning: {
    bayesTuning: boolean;
    bayes: {
      gamma: number;          // top-quantile fraction for the "good" set
      nCandidates: number;    // EI candidate draws per ask
      nStartup: number;       // random/jittered startup evals before the model kicks in
      bandwidthFrac: number;  // KDE bandwidth as a fraction of each dimension's range
    };
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  universe: ["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT"],
  primarySymbol: "BTC/USDT",
  tf: "1h",
  sealDate: "2026-02-01",
  historyStart: "2021-06-01",
  floors: DEFAULT_FLOORS,
  autoPromote: true,
  paperStartEquity: 10_000,
  killSwitch: { dailyDD: -0.05, weeklyDD: -0.10, monthlyDD: -0.20 },
  // GP-dominant refinement of the scored board; random grammar samples are a
  // trickle for diversity only — the library seeds are the real fresh blood.
  evo: { batchGp: 18, batchFresh: 2, batchLlm: 4, maxCandidatesPerDay: 240 },
  llmDailyBudgetUsd: 1.0,
  // SHADOW MODE: compute the honesty metrics and LOG would-fail flags, but never
  // bind them. `bind` stays false until Daniel sets thresholds from real data.
  shadowRigor: {
    compute: true,
    bind: false,
    pboBlocks: 10,
    pboWarnAt: 0.5,
    stabilityWarnAt: 0.4,
    regimeMinObs: 30,
    regimeMinSharpeWarnAt: 0,
    realityCheck: true,
    rcReps: 1000,
    rcWarnAt: 0.1,
    // CALIBRATION PASS — NOW BINDING: reject overfit (PBO >= 0.6) at/after S5.
    pbo: { bind: true, max: 0.6 },
    // CALIBRATION PASS — NOW BINDING (lenient starting thresholds): reject a
    // candidate that is broken in a well-populated regime (Sharpe < -0.5) or
    // whose positive PnL is concentrated in one regime (>80%).
    regime: { bind: true, minObs: 30, minSharpe: -0.5, maxPnlConcentration: 0.8 },
  },
  // CALIBRATION PASS — purged+embargoed walk-forward is now the binding S3/S4 WF.
  walkforward: { purged: true },
  // CALIBRATION PASS — IC-steered generation is ON.
  icSteering: true,
  // CALIBRATION PASS — book-diversification eligibility is ON (approval gate unchanged).
  bookPromotion: true,
  // WAVE-2 SHADOW: diversification book + capacity/impact. Computed and logged,
  // never binding. Toggle off via {enabled:false} in the Convex config override.
  book: {
    enabled: true,
    minMarginalSharpe: 0.1,
    maxCorr: 0.6,
    // BOOK-MARGINAL GATE defaults. marginalGate=false here; shipped ON via the
    // live Convex override as a ready receiver. A/B/C knobs match the reviewed
    // spec: per-sleeve bootstrap-CI-lo>0 + deflated(p5)>=0; book-level Sharpe>=1.0,
    // deflated(p5)>=1.0, meanAbsCorr<=0.5. These PROMOTE NOTHING until a genuinely
    // diversified book clears level-C.
    marginalGate: false,
    sleeveMinBootLo: 0,
    sleeveMinDeflated: 0,
    bookMinSharpe: 1.0,
    bookMinDeflated: 1.0,
    bookMaxMeanCorr: 0.5,
  },
  capacity: {
    enabled: true,
    k: 0.7,
    capFloorFrac: 0.5,
    capFloorAbs: 0.5,
    refAumUsd: 100_000,
    advWindow: 720,
  },
  // WAVE-3b: behavior flags DEFAULT FALSE — current live behavior is unchanged.
  // Premium TAGGING (the label + premiumStats rollup) is live regardless; only
  // the new anchored prompt and the Bayesian tuner are gated here.
  generation: {
    premiumAnchoredGen: true,
  },
  tuning: {
    bayesTuning: true,
    bayes: { gamma: 0.25, nCandidates: 24, nStartup: 8, bandwidthFrac: 0.12 },
  },
};

export function mergeConfig(json: string | null): AppConfig {
  if (!json) return DEFAULT_CONFIG;
  try {
    const parsed = JSON.parse(json) as Partial<AppConfig>;
    return { ...DEFAULT_CONFIG, ...parsed, floors: { ...DEFAULT_FLOORS, ...(parsed.floors ?? {}) }, killSwitch: { ...DEFAULT_CONFIG.killSwitch, ...(parsed.killSwitch ?? {}) }, evo: { ...DEFAULT_CONFIG.evo, ...(parsed.evo ?? {}) }, shadowRigor: { ...DEFAULT_CONFIG.shadowRigor, ...(parsed.shadowRigor ?? {}), pbo: { ...DEFAULT_CONFIG.shadowRigor.pbo, ...(parsed.shadowRigor?.pbo ?? {}) }, regime: { ...DEFAULT_CONFIG.shadowRigor.regime, ...(parsed.shadowRigor?.regime ?? {}) } }, book: { ...DEFAULT_CONFIG.book, ...(parsed.book ?? {}) }, capacity: { ...DEFAULT_CONFIG.capacity, ...(parsed.capacity ?? {}) }, walkforward: { ...DEFAULT_CONFIG.walkforward, ...(parsed.walkforward ?? {}) }, generation: { ...DEFAULT_CONFIG.generation, ...(parsed.generation ?? {}) }, tuning: { ...DEFAULT_CONFIG.tuning, ...(parsed.tuning ?? {}), bayes: { ...DEFAULT_CONFIG.tuning.bayes, ...(parsed.tuning?.bayes ?? {}) } } };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function todayKey(prefix: string): string {
  return `${prefix}:${new Date().toISOString().slice(0, 10)}`;
}
