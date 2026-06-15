// WAVE-3b: per-risk-premium-family outcome rollups (ADDITIVE). Mirrors the
// mechanismStats pattern in ledger.ts, but keyed by the inferred premium family
// (trend_momentum / carry_funding / basis_term_structure / ...). At gauntlet
// completion we attribute the candidate's outcome to its premium so the engine
// learns which PREMIA actually pay; generation can read premiumSnapshot later to
// prefer high-yield families. LIVE-ADDITIVE: reads never bind promotion.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// reachedStage values that count as "survived past S2/train" (same set as the
// knowledge ledger, kept local to avoid cross-module coupling).
const PAST_S3 = new Set([
  "S4-cross-symbol", "S4-portfolio", "S5-stats", "S5b-stress", "S6-sealed",
  "S7-paper", "incubating", "eligible", "champion", "sealed_passed",
]);
const PROMOTED_STAGES = new Set(["incubating", "eligible", "champion"]);

/** All premium-family rows, with derived mean composite + survival rate. Empty
 *  => cold-start. Readable by generation to bias toward premia that pay. */
export const premiumSnapshot = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("premiumStats").collect();
    return rows.map((r) => ({
      premium: r.premium,
      attempts: r.attempts,
      survived: r.survived,
      promotions: r.promotions,
      survivalRate: r.attempts > 0 ? r.survived / r.attempts : 0,
      meanComposite: r.compositeN > 0 ? r.compositeSum / r.compositeN : 0,
      compositeN: r.compositeN,
      failedSealed: r.failedSealed,
      failedS4: r.failedS4,
    }));
  },
});

/** One family row by key (for a generation-time prior on a specific premium). */
export const premiumMean = query({
  args: { premium: v.string() },
  handler: async (ctx, { premium }) => {
    const row = await ctx.db.query("premiumStats").withIndex("by_premium", (q) => q.eq("premium", premium)).first();
    if (!row) return { meanComposite: 0, attempts: 0, survivalRate: 0 };
    return {
      meanComposite: row.compositeN > 0 ? row.compositeSum / row.compositeN : 0,
      attempts: row.attempts,
      survivalRate: row.attempts > 0 ? row.survived / row.attempts : 0,
    };
  },
});

/**
 * Attribute a finished candidate's outcome to its premium family. Called from
 * the gauntlet-completion path (processCandidate.finalizeLedger) alongside the
 * mechanism ledger. Best-effort + idempotent-per-call; a hiccup must never break
 * the gauntlet (the caller wraps it in try/catch). No-op when premium is absent.
 */
export const recordPremiumOutcome = mutation({
  args: {
    premium: v.string(),
    reachedStage: v.string(),
    composite: v.optional(v.number()),
  },
  handler: async (ctx, { premium, reachedStage, composite }) => {
    if (!premium) return;
    const survived = PAST_S3.has(reachedStage);
    const promoted = PROMOTED_STAGES.has(reachedStage);
    const row = await ctx.db.query("premiumStats").withIndex("by_premium", (q) => q.eq("premium", premium)).first();
    if (row) {
      await ctx.db.patch(row._id, {
        attempts: row.attempts + 1,
        survived: row.survived + (survived ? 1 : 0),
        promotions: row.promotions + (promoted ? 1 : 0),
        compositeSum: row.compositeSum + (composite ?? 0),
        compositeN: row.compositeN + (composite !== undefined ? 1 : 0),
        failedSealed: row.failedSealed + (reachedStage === "S6-sealed" ? 1 : 0),
        failedS4: row.failedS4 + (reachedStage.startsWith("S4") ? 1 : 0),
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("premiumStats", {
        premium,
        attempts: 1,
        survived: survived ? 1 : 0,
        promotions: promoted ? 1 : 0,
        compositeSum: composite ?? 0,
        compositeN: composite !== undefined ? 1 : 0,
        failedSealed: reachedStage === "S6-sealed" ? 1 : 0,
        failedS4: reachedStage.startsWith("S4") ? 1 : 0,
        updatedAt: Date.now(),
      });
    }
  },
});
