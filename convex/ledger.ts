// Knowledge ledger: structured per-recipe outcome rollups that turn the
// evolution loop from uniform-random into learned (Thompson-sampled) selection,
// plus per-candidate provenance for surprise tracking. ADDITIVE — these are new
// tables; nothing existing is touched.
//
// A "recipe" is a mutation/lane key: "gp-op:<op>" (e.g. "gp-op:add_filter"),
// "gp-op:repair_<...>", "crossover", "fresh", "llm", "seed", "imported".
// "success" = the candidate reached at least walk-forward (S3) — a meaningful
// signal that the recipe produced temporal structure, not noise.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const PAST_S3 = new Set(["S4-cross-symbol", "S4-portfolio", "S5-stats", "S5b-stress", "S6-sealed", "S7-paper", "incubating", "eligible", "champion", "sealed_passed"]);
// reachedStage values that count as "made progress past S2/train"
function isSuccess(reachedStage: string): boolean {
  return PAST_S3.has(reachedStage);
}

// ---------------------------------------------------------------- read (per cycle)
/** All global mechanism rows (family === undefined). Empty => cold-start (uniform). */
export const ledgerSnapshot = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("mechanismStats").withIndex("by_family", (q) => q.eq("family", undefined)).collect();
    return rows.map((r) => ({
      mechanism: r.mechanism,
      attempts: r.attempts,
      alpha: r.alpha,
      beta: r.beta,
      promotions: r.promotions,
      compositeSum: r.compositeSum,
      compositeN: r.compositeN,
      meanComposite: r.compositeN > 0 ? r.compositeSum / r.compositeN : 0,
      failedSealed: r.failedSealed,
      failedS4: r.failedS4,
    }));
  },
});

/** One mechanism row (global) by key — for surprise baselines at generation time. */
export const mechanismMean = query({
  args: { mechanism: v.string() },
  handler: async (ctx, { mechanism }) => {
    const row = await ctx.db
      .query("mechanismStats")
      .withIndex("by_key", (q) => q.eq("mechanism", mechanism).eq("family", undefined))
      .first();
    if (!row) return { meanComposite: 0, attempts: 0 };
    return { meanComposite: row.compositeN > 0 ? row.compositeSum / row.compositeN : 0, attempts: row.attempts };
  },
});

// ---------------------------------------------------------------- provenance
export const recordProvenance = mutation({
  args: {
    candidateId: v.id("candidates"),
    mechanism: v.string(),
    family: v.string(),
    parentComposite: v.optional(v.number()),
    expectedComposite: v.optional(v.number()),
    wild: v.boolean(),
  },
  handler: async (ctx, a) => {
    await ctx.db.insert("candidateProvenance", { ...a, createdAt: Date.now() });
    // bump the attempt counter eagerly (global row), so selection sees fresh
    // attempt counts even before the candidate finishes the gauntlet.
    await bumpAttempt(ctx, a.mechanism);
  },
});

async function bumpAttempt(ctx: any, mechanism: string) {
  const row = await ctx.db
    .query("mechanismStats")
    .withIndex("by_key", (q: any) => q.eq("mechanism", mechanism).eq("family", undefined))
    .first();
  if (row) {
    await ctx.db.patch(row._id, { attempts: row.attempts + 1, updatedAt: Date.now() });
  } else {
    await ctx.db.insert("mechanismStats", {
      mechanism, family: undefined,
      attempts: 1, alpha: 1, beta: 1, promotions: 0,
      compositeSum: 0, compositeN: 0, failedSealed: 0, failedS4: 0,
      surpriseSum: 0, surpriseN: 0, updatedAt: Date.now(),
    });
  }
}

// ---------------------------------------------------------------- outcome (at gauntlet completion)
export const recordOutcome = mutation({
  args: {
    candidateId: v.id("candidates"),
    reachedStage: v.string(),     // failedStage if killed, else the live stage
    composite: v.optional(v.number()),
    promoted: v.optional(v.boolean()),
  },
  handler: async (ctx, { candidateId, reachedStage, composite, promoted }) => {
    const prov = await ctx.db
      .query("candidateProvenance")
      .withIndex("by_candidate", (q) => q.eq("candidateId", candidateId))
      .first();
    if (!prov) return { surprise: null }; // no provenance (e.g. seed pre-wiring) — nothing to attribute

    const success = isSuccess(reachedStage);
    const row = await ctx.db
      .query("mechanismStats")
      .withIndex("by_key", (q) => q.eq("mechanism", prov.mechanism).eq("family", undefined))
      .first();

    const expected = prov.expectedComposite ?? 0;
    const surprise = composite !== undefined ? composite - expected : null;

    const patch: Record<string, number> = {};
    if (row) {
      patch.alpha = row.alpha + (success ? 1 : 0);
      patch.beta = row.beta + (success ? 0 : 1);
      patch.promotions = row.promotions + (promoted ? 1 : 0);
      if (composite !== undefined) {
        patch.compositeSum = row.compositeSum + composite;
        patch.compositeN = row.compositeN + 1;
      }
      patch.failedSealed = row.failedSealed + (reachedStage === "S6-sealed" ? 1 : 0);
      patch.failedS4 = row.failedS4 + (reachedStage.startsWith("S4") ? 1 : 0);
      if (surprise !== null) { patch.surpriseSum = row.surpriseSum + surprise; patch.surpriseN = row.surpriseN + 1; }
      await ctx.db.patch(row._id, { ...patch, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("mechanismStats", {
        mechanism: prov.mechanism, family: undefined,
        attempts: 1,
        alpha: 1 + (success ? 1 : 0), beta: 1 + (success ? 0 : 1),
        promotions: promoted ? 1 : 0,
        compositeSum: composite ?? 0, compositeN: composite !== undefined ? 1 : 0,
        failedSealed: reachedStage === "S6-sealed" ? 1 : 0,
        failedS4: reachedStage.startsWith("S4") ? 1 : 0,
        surpriseSum: surprise ?? 0, surpriseN: surprise !== null ? 1 : 0,
        updatedAt: Date.now(),
      });
    }

    return { surprise, mechanism: prov.mechanism, wild: prov.wild };
  },
});

// ---------------------------------------------------------------- surprise log
export const recordSurprise = mutation({
  args: {
    candidateId: v.id("candidates"),
    mechanism: v.string(),
    expected: v.number(),
    actual: v.number(),
    surprise: v.number(),
    wild: v.boolean(),
    reachedStage: v.string(),
  },
  handler: async (ctx, a) => {
    await ctx.db.insert("surpriseLog", { ...a, createdAt: Date.now() });
  },
});

export const recentSurprises = query({
  args: { limit: v.optional(v.number()) },
  handler: (ctx, { limit }) =>
    ctx.db.query("surpriseLog").withIndex("by_createdAt").order("desc").take(limit ?? 50),
});
