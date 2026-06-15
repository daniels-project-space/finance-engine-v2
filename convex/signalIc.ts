// Convex accessors for the WAVE-3a SHADOW signal-IC report. A single row
// (key="current") holds the pooled IC-IR ranking of every catalog signal over
// the pre-seal dev period. SHADOW-ONLY: nothing here drives promotion — the
// dashboard / generation can READ it later to prefer high-IC signals.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const rankedObj = v.object({
  name: v.string(),
  icMean: v.number(),
  icIR: v.number(),
  tStat: v.number(),
  n: v.number(),
  pooledIC: v.number(),
  maxCorrToBetter: v.number(),
  redundantWith: v.optional(v.string()),
  redundant: v.boolean(),
  cryptoNative: v.boolean(),
});

/** The current IC report (or null if never built). */
export const get = query({
  args: {},
  handler: async (ctx) =>
    ctx.db.query("signalIcReports").withIndex("by_key", (q) => q.eq("key", "current")).first(),
});

/** Replace the current IC report row (idempotent singleton upsert). */
export const upsert = mutation({
  args: {
    horizon: v.number(),
    redundancyCorr: v.number(),
    symbolsPooled: v.array(v.string()),
    ranked: v.array(rankedObj),
  },
  handler: async (ctx, { horizon, redundancyCorr, symbolsPooled, ranked }) => {
    const now = Date.now();
    const existing = await ctx.db.query("signalIcReports").withIndex("by_key", (q) => q.eq("key", "current")).first();
    const row = { key: "current", horizon, redundancyCorr, symbolsPooled, ranked, updatedAt: now };
    if (existing) { await ctx.db.patch(existing._id, row); return existing._id; }
    return ctx.db.insert("signalIcReports", row);
  },
});
