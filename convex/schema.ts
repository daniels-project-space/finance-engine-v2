import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // A candidate strategy moving through the pipeline.
  // stage: generated -> queued -> gauntlet -> sealed_passed -> incubating -> eligible -> champion
  //        | failed | graveyard | demoted | archived
  candidates: defineTable({
    name: v.string(),
    source: v.string(),            // "gp" | "llm" | "seed" | "mutation" | "crossover"
    parentIds: v.optional(v.array(v.string())),
    dsl: v.string(),               // JSON StrategyDoc
    hash: v.string(),
    familyHash: v.string(),
    hypothesis: v.string(),
    stage: v.string(),
    failedStage: v.optional(v.string()),
    failedReason: v.optional(v.string()),
    bestParams: v.optional(v.string()),   // JSON
    metrics: v.optional(v.string()),      // JSON GauntletReport.metrics + sealed + trade stats
    curves: v.optional(v.string()),       // JSON {full,wf,sealed} downsampled equity paths
    composite: v.optional(v.number()),
    incubationStartedAt: v.optional(v.number()),
    mechanism: v.optional(v.string()),    // intelligence upgrade: recipe key that produced this candidate
    surprise: v.optional(v.number()),     // actual composite - expected (recipe mean) at evaluation
    premium: v.optional(v.string()),      // WAVE-3b: inferred risk-premium family (LIVE-ADDITIVE label)
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_stage", ["stage"])
    .index("by_hash", ["hash"])
    .index("by_composite", ["composite"]),

  gateReports: defineTable({
    candidateId: v.id("candidates"),
    stage: v.string(),
    passed: v.boolean(),
    reason: v.optional(v.string()),
    report: v.string(),            // JSON detail
    durationMs: v.number(),
    createdAt: v.number(),
  }).index("by_candidate", ["candidateId"]),

  lessons: defineTable({
    source: v.string(),            // generator family that produced the candidate
    text: v.string(),
    candidateId: v.optional(v.id("candidates")),
    stage: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),

  fingerprints: defineTable({
    hash: v.string(),
    familyHash: v.string(),
    createdAt: v.number(),
  })
    .index("by_hash", ["hash"])
    .index("by_family", ["familyHash"]),

  penaltyBox: defineTable({
    familyHash: v.string(),
    reason: v.string(),
    until: v.number(),
    createdAt: v.number(),
  }).index("by_family", ["familyHash"]),

  // one-shot seal enforcement: a candidate hash may run the sealed holdout ONCE ever
  holdoutRuns: defineTable({
    hash: v.string(),
    sealTs: v.number(),
    result: v.string(),            // JSON
    passed: v.boolean(),
    createdAt: v.number(),
  }).index("by_hash", ["hash"]),

  promotions: defineTable({
    candidateId: v.id("candidates"),
    fromChampionId: v.optional(v.id("candidates")),
    action: v.string(),            // "promote" | "demote" | "rollback"
    approvedBy: v.string(),        // "auto" | "daniel"
    composite: v.optional(v.number()),
    note: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),

  // live paper state per candidate per symbol
  paperPositions: defineTable({
    candidateId: v.id("candidates"),
    symbol: v.string(),
    weight: v.number(),
    entryPrice: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_candidate", ["candidateId"]),

  paperAccounts: defineTable({
    candidateId: v.id("candidates"),
    equity: v.number(),
    peakEquity: v.number(),
    startedAt: v.number(),
    halted: v.boolean(),
    haltReason: v.optional(v.string()),
    lastStepTs: v.optional(v.number()),
    // drawdown-circuit-breaker exposure scale (blend sleeve only; hysteresis state).
    // Optional + backward-compatible: absent => treated as 1 (full exposure).
    guardScale: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_candidate", ["candidateId"]),

  paperTrades: defineTable({
    candidateId: v.id("candidates"),
    symbol: v.string(),
    ts: v.number(),
    weightFrom: v.number(),
    weightTo: v.number(),
    price: v.number(),
    fillPrice: v.number(),
    costUsd: v.number(),
    note: v.optional(v.string()),
  }).index("by_candidate", ["candidateId", "ts"]),

  equitySnapshots: defineTable({
    candidateId: v.id("candidates"),
    ts: v.number(),
    equity: v.number(),
    ret: v.number(),
  }).index("by_candidate_ts", ["candidateId", "ts"]),

  // Precomputed indicator track for the live Watch tab — one row per candidate,
  // rebuilt by the indicators Trigger task (which has R2 + on-chain access) so the
  // page can read the full chart (daily candles + indicator series + the exact
  // trigger lines) reactively without any heavy compute in a Convex query.
  // `json` is a serialized StrategyIndicators (src/engine/indicators.ts).
  strategyIndicators: defineTable({
    candidateId: v.id("candidates"),
    updatedAt: v.number(),
    json: v.string(),
  }).index("by_candidate", ["candidateId"]),

  datasets: defineTable({
    symbol: v.string(),
    tf: v.string(),
    firstTs: v.number(),
    lastTs: v.number(),
    bars: v.number(),
    gaps: v.number(),
    fundingLastTs: v.optional(v.number()),
    r2Key: v.string(),
    updatedAt: v.number(),
  }).index("by_symbol_tf", ["symbol", "tf"]),

  runs: defineTable({
    kind: v.string(),              // "evolve" | "ingest" | "gauntlet" | "paper" | "monitor"
    status: v.string(),            // "running" | "ok" | "error"
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    summary: v.optional(v.string()), // JSON
  }).index("by_kind", ["kind"]),

  counters: defineTable({
    key: v.string(),               // e.g. "llm_usd:2026-06-12", "trials_total"
    value: v.number(),
  }).index("by_key", ["key"]),

  config: defineTable({
    key: v.string(),
    json: v.string(),
  }).index("by_key", ["key"]),

  // ---- intelligence upgrade (ADDITIVE) ----
  // Per-recipe outcome rollup — the bandit's prior, read once per cycle.
  // family is undefined for the global rows the bandit samples from (a slot is
  // reserved for future per-family rows). alpha/beta are Beta pseudo-counts for
  // the "reached >= S3" success signal; the bandit also folds in a runtime
  // suppression scalar from the penalty graveyard.
  mechanismStats: defineTable({
    mechanism: v.string(),          // recipe key: "gp-op:<op>" | "crossover" | "fresh" | "llm" | "seed" | "imported"
    family: v.optional(v.string()), // familyHash, or undefined for global rows
    attempts: v.number(),
    alpha: v.number(),              // 1 + successes (reached >= S3)
    beta: v.number(),               // 1 + failures
    promotions: v.number(),
    compositeSum: v.number(),       // running sum of composite (mean = sum/N)
    compositeN: v.number(),
    failedSealed: v.number(),       // died at S6-sealed (overfit signal)
    failedS4: v.number(),           // died cross-symbol/portfolio
    surpriseSum: v.number(),
    surpriseN: v.number(),
    updatedAt: v.number(),
  })
    .index("by_key", ["mechanism", "family"])
    .index("by_family", ["family"])
    .index("by_mechanism", ["mechanism"]),

  // Per-candidate provenance so completion can attribute outcomes back to a
  // recipe and compute surprise = actual composite - expectedComposite.
  candidateProvenance: defineTable({
    candidateId: v.id("candidates"),
    mechanism: v.string(),
    family: v.string(),
    parentComposite: v.optional(v.number()),
    expectedComposite: v.optional(v.number()),
    wild: v.boolean(),              // injected exploratory (anti-Thompson / epsilon) mutation?
    createdAt: v.number(),
  }).index("by_candidate", ["candidateId"]),

  // Surprise events (actual >> expected on a recipe) — fed into lessons + logged.
  surpriseLog: defineTable({
    candidateId: v.id("candidates"),
    mechanism: v.string(),
    expected: v.number(),
    actual: v.number(),
    surprise: v.number(),
    wild: v.boolean(),
    reachedStage: v.string(),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),

  // ---- WAVE-2 SHADOW (ADDITIVE) ----
  // The correlation-aware diversification BOOK: an ERC-weighted ensemble of the
  // most recent S4+ survivors / incubating candidates' OOS streams. SHADOW: the
  // book never drives promotion. `key` is a singleton row ("current"). members
  // carry per-strategy weight + risk contribution + standalone Sharpe; stats is
  // the book's OOS Sharpe/vol/maxDD. Empty members[] is the live steady state
  // until a strategy survives.
  book: defineTable({
    key: v.string(),                // singleton: "current"
    members: v.array(v.object({
      candidateId: v.string(),
      name: v.string(),
      weight: v.number(),
      riskContrib: v.number(),
      standaloneSharpe: v.number(),
    })),
    weights: v.array(v.number()),
    stats: v.object({
      sharpe: v.number(),
      vol: v.number(),
      maxDD: v.number(),
      meanRet: v.number(),
      nBars: v.number(),
    }),
    meanAbsCorr: v.number(),        // mean off-diagonal |correlation| (diversification gauge)
    nMembers: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // ---- WAVE-3a SHADOW (ADDITIVE) ----
  // Signal-IC research report: the pooled IC-IR ranking of every catalog signal
  // (incl. the crypto-native ones) over the pre-seal dev period, so generation /
  // the dashboard can later PREFER high-IC signals. SHADOW: never drives anything.
  // `key` is a singleton row ("current"). Rebuilt by the IC-ranking routine.
  signalIcReports: defineTable({
    key: v.string(),                // singleton: "current"
    horizon: v.number(),            // forward-return label horizon (bars)
    redundancyCorr: v.number(),     // |corr| threshold for the redundancy flag
    symbolsPooled: v.array(v.string()),
    ranked: v.array(v.object({
      name: v.string(),
      icMean: v.number(),
      icIR: v.number(),
      tStat: v.number(),
      n: v.number(),
      pooledIC: v.number(),
      maxCorrToBetter: v.number(),
      redundantWith: v.optional(v.string()),
      redundant: v.boolean(),
      cryptoNative: v.boolean(),    // is this one of the WAVE-3a crypto-native signals?
    })),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // ---- WAVE-3b (ADDITIVE) ----
  // Per-risk-premium-family outcome rollup — mirrors mechanismStats but keyed by
  // the inferred premium family (trend_momentum / carry_funding / ...), so the
  // engine learns which PREMIA actually pay and generation can later prefer them.
  // LIVE-ADDITIVE: written at gauntlet completion; reads never bind promotion.
  premiumStats: defineTable({
    premium: v.string(),            // PremiumFamily key
    attempts: v.number(),           // candidates tagged with this premium that reached an outcome
    survived: v.number(),           // reached >= S3 (made temporal-structure progress)
    promotions: v.number(),         // reached incubation/eligible/champion
    compositeSum: v.number(),       // running sum of composite (mean = sum/N)
    compositeN: v.number(),
    failedSealed: v.number(),       // died at S6-sealed (overfit signal for this premium)
    failedS4: v.number(),           // died cross-symbol/portfolio
    updatedAt: v.number(),
  }).index("by_premium", ["premium"]),
});
