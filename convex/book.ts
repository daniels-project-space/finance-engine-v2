// Convex accessors for the WAVE-2 SHADOW diversification book. A single row
// (key="current") holds the ERC-weighted ensemble of recent S4+ survivors /
// incubating candidates. SHADOW-ONLY: nothing here drives promotion.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const memberObj = v.object({
  candidateId: v.string(),
  name: v.string(),
  weight: v.number(),
  riskContrib: v.number(),
  standaloneSharpe: v.number(),
});

const statsObj = v.object({
  sharpe: v.number(),
  vol: v.number(),
  maxDD: v.number(),
  meanRet: v.number(),
  nBars: v.number(),
});

/** The current book (or null if never built). */
export const get = query({
  args: {},
  handler: async (ctx) =>
    ctx.db.query("book").withIndex("by_key", (q) => q.eq("key", "current")).first(),
});

/** Replace the current book row (idempotent singleton upsert). */
export const upsert = mutation({
  args: {
    members: v.array(memberObj),
    weights: v.array(v.number()),
    stats: statsObj,
    meanAbsCorr: v.number(),
  },
  handler: async (ctx, { members, weights, stats, meanAbsCorr }) => {
    const now = Date.now();
    const existing = await ctx.db.query("book").withIndex("by_key", (q) => q.eq("key", "current")).first();
    const row = { key: "current", members, weights, stats, meanAbsCorr, nMembers: members.length, updatedAt: now };
    if (existing) { await ctx.db.patch(existing._id, row); return existing._id; }
    return ctx.db.insert("book", row);
  },
});
