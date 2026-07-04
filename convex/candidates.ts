import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const create = mutation({
  args: {
    name: v.string(), source: v.string(), parentIds: v.optional(v.array(v.string())),
    dsl: v.string(), hash: v.string(), familyHash: v.string(), hypothesis: v.string(),
    mechanism: v.optional(v.string()),   // intelligence upgrade: recipe key (bandit attribution)
    premium: v.optional(v.string()),     // WAVE-3b: inferred risk-premium family (LIVE-ADDITIVE label)
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("candidates").withIndex("by_hash", (q) => q.eq("hash", args.hash)).first();
    if (existing) return { id: existing._id, duplicate: true };
    const now = Date.now();
    const id = await ctx.db.insert("candidates", { ...args, stage: "generated", createdAt: now, updatedAt: now });
    await ctx.db.insert("fingerprints", { hash: args.hash, familyHash: args.familyHash, createdAt: now });
    return { id, duplicate: false };
  },
});

export const updateStage = mutation({
  args: {
    id: v.id("candidates"), stage: v.string(),
    failedStage: v.optional(v.string()), failedReason: v.optional(v.string()),
    bestParams: v.optional(v.string()), metrics: v.optional(v.string()),
    curves: v.optional(v.string()), dsl: v.optional(v.string()), hypothesis: v.optional(v.string()),
    composite: v.optional(v.number()), incubationStartedAt: v.optional(v.number()),
  },
  handler: async (ctx, { id, ...rest }) => {
    await ctx.db.patch(id, { ...Object.fromEntries(Object.entries(rest).filter(([, x]) => x !== undefined)), updatedAt: Date.now() });
  },
});

export const get = query({
  args: { id: v.id("candidates") },
  handler: (ctx, { id }) => ctx.db.get(id),
});

// intelligence upgrade: persist a candidate's surprise (actual - expected).
export const setSurprise = mutation({
  args: { id: v.id("candidates"), surprise: v.number() },
  handler: (ctx, { id, surprise }) => ctx.db.patch(id, { surprise, updatedAt: Date.now() }),
});

// WAVE-3b: persist a candidate's inferred risk-premium family (LIVE-ADDITIVE).
export const setPremium = mutation({
  args: { id: v.id("candidates"), premium: v.string() },
  handler: (ctx, { id, premium }) => ctx.db.patch(id, { premium, updatedAt: Date.now() }),
});

export const listByStage = query({
  args: { stage: v.string(), limit: v.optional(v.number()) },
  handler: (ctx, { stage, limit }) =>
    ctx.db.query("candidates").withIndex("by_stage", (q) => q.eq("stage", stage)).order("desc").take(limit ?? 100),
});

export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: (ctx, { limit }) => ctx.db.query("candidates").order("desc").take(limit ?? 50),
});

export const leaderboard = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db.query("candidates").withIndex("by_composite").order("desc").take((limit ?? 20) * 2);
    return rows.filter((r) => r.composite !== undefined && !["failed", "graveyard", "archived"].includes(r.stage)).slice(0, limit ?? 20);
  },
});

/** Tournament board: every scored candidate (including near-miss failures), ranked. */
export const tournament = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db.query("candidates").withIndex("by_composite").order("desc").take(limit ?? 80);
    return rows.filter((r) => r.composite !== undefined);
  },
});

export const champion = query({
  args: {},
  handler: async (ctx) =>
    ctx.db.query("candidates").withIndex("by_stage", (q) => q.eq("stage", "champion")).first(),
});

// (funnel + analytics full-scan queries removed 2026-07-04 — they exceeded the
//  16MB read limit once the table grew and had no UI callers; the materialized
//  equivalents live in convex/summaries.ts.)

/** Find an ALIVE candidate by exact name (live-deploy CLI). Scans only the small
 *  alive stages, never the failed pile. Returns matches (name collisions happen —
 *  the caller disambiguates by id). */
export const findAliveByName = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const out = [];
    for (const stage of ["incubating", "eligible", "champion", "sealed_passed"]) {
      const rows = await ctx.db.query("candidates").withIndex("by_stage", (q) => q.eq("stage", stage)).collect();
      for (const r of rows) if (r.name === name) out.push({ id: r._id, name: r.name, stage: r.stage, composite: r.composite ?? null, createdAt: r.createdAt });
    }
    return out;
  },
});

export const hashExists = query({
  args: { hash: v.string() },
  handler: async (ctx, { hash }) =>
    !!(await ctx.db.query("fingerprints").withIndex("by_hash", (q) => q.eq("hash", hash)).first()),
});

export const familySeenCount = query({
  args: { familyHash: v.string() },
  handler: async (ctx, { familyHash }) =>
    (await ctx.db.query("fingerprints").withIndex("by_family", (q) => q.eq("familyHash", familyHash)).collect()).length,
});
