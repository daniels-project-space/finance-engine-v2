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
    curves: v.optional(v.string()),
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

export const funnel = query({
  args: {},
  handler: async (ctx) => {
    const stages = ["generated", "queued", "gauntlet", "failed", "sealed_passed", "incubating", "eligible", "champion", "demoted", "graveyard"];
    const out: Record<string, number> = {};
    for (const s of stages) {
      const rows = await ctx.db.query("candidates").withIndex("by_stage", (q) => q.eq("stage", s)).collect();
      out[s] = rows.length;
    }
    return out;
  },
});

/** Dashboard analytics: progression of scores over time, kill distribution, lane attribution. */
export const analytics = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("candidates").collect();
    const killsByStage: Record<string, number> = {};
    const sourceStats: Record<string, { count: number; best: number; scored: number; deepest: string }> = {};
    const progression: { t: number; c: number; source: string; name: string }[] = [];
    const STAGE_DEPTH: Record<string, number> = {
      "S1-penalty": 1, "S2-train": 2, "S3-walkforward": 3, "S4-cross-symbol": 4,
      "S4-portfolio": 4.5, "S5-stats": 5, "S5b-stress": 5.5, "S6-sealed": 6, "S7-paper": 7,
    };
    for (const r of all) {
      if (r.failedStage) killsByStage[r.failedStage] = (killsByStage[r.failedStage] ?? 0) + 1;
      const s = (sourceStats[r.source] ??= { count: 0, best: -9, scored: 0, deepest: "" });
      s.count++;
      if (r.composite !== undefined) {
        s.scored++;
        if (r.composite > s.best) s.best = r.composite;
        progression.push({ t: r.createdAt, c: r.composite, source: r.source, name: r.name });
      }
      const depth = STAGE_DEPTH[r.failedStage ?? ""] ?? (["incubating", "eligible", "champion", "sealed_passed"].includes(r.stage) ? 8 : 0);
      const curDepth = STAGE_DEPTH[s.deepest] ?? 0;
      if (depth > curDepth && r.failedStage) s.deepest = r.failedStage;
    }
    progression.sort((a, b) => a.t - b.t);
    return {
      total: all.length,
      killsByStage,
      sourceStats,
      progression: progression.slice(-500),
      firstAt: all.length ? Math.min(...all.map((r) => r.createdAt)) : 0,
    };
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
