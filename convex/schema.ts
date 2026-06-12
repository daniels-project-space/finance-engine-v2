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
});
