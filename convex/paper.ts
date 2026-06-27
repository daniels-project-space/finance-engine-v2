import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const getAccount = query({
  args: { candidateId: v.id("candidates") },
  handler: (ctx, { candidateId }) =>
    ctx.db.query("paperAccounts").withIndex("by_candidate", (q) => q.eq("candidateId", candidateId)).first(),
});

export const ensureAccount = mutation({
  args: { candidateId: v.id("candidates"), startEquity: v.number() },
  handler: async (ctx, { candidateId, startEquity }) => {
    const existing = await ctx.db.query("paperAccounts").withIndex("by_candidate", (q) => q.eq("candidateId", candidateId)).first();
    if (existing) return existing._id;
    return ctx.db.insert("paperAccounts", {
      candidateId, equity: startEquity, peakEquity: startEquity,
      startedAt: Date.now(), halted: false, updatedAt: Date.now(),
    });
  },
});

export const positionsFor = query({
  args: { candidateId: v.id("candidates") },
  handler: (ctx, { candidateId }) =>
    ctx.db.query("paperPositions").withIndex("by_candidate", (q) => q.eq("candidateId", candidateId)).collect(),
});

export const applyStep = mutation({
  args: {
    candidateId: v.id("candidates"),
    ts: v.number(),
    equity: v.number(),
    ret: v.number(),
    halted: v.optional(v.boolean()),
    haltReason: v.optional(v.string()),
    guardScale: v.optional(v.number()),
    positions: v.array(v.object({ symbol: v.string(), weight: v.number(), entryPrice: v.optional(v.number()) })),
    trades: v.array(v.object({
      symbol: v.string(), ts: v.number(), weightFrom: v.number(), weightTo: v.number(),
      price: v.number(), fillPrice: v.number(), costUsd: v.number(), note: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const acct = await ctx.db.query("paperAccounts").withIndex("by_candidate", (q) => q.eq("candidateId", args.candidateId)).first();
    if (!acct) throw new Error("no paper account");
    if (acct.lastStepTs && acct.lastStepTs >= args.ts) return { skipped: true }; // idempotency
    await ctx.db.patch(acct._id, {
      equity: args.equity,
      peakEquity: Math.max(acct.peakEquity, args.equity),
      halted: args.halted ?? acct.halted,
      haltReason: args.haltReason ?? acct.haltReason,
      lastStepTs: args.ts,
      ...(args.guardScale !== undefined ? { guardScale: args.guardScale } : {}),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("equitySnapshots", { candidateId: args.candidateId, ts: args.ts, equity: args.equity, ret: args.ret });
    // upsert positions
    const existing = await ctx.db.query("paperPositions").withIndex("by_candidate", (q) => q.eq("candidateId", args.candidateId)).collect();
    const bySymbol = new Map(existing.map((p) => [p.symbol, p]));
    for (const pos of args.positions) {
      const cur = bySymbol.get(pos.symbol);
      if (cur) await ctx.db.patch(cur._id, { weight: pos.weight, entryPrice: pos.entryPrice, updatedAt: Date.now() });
      else await ctx.db.insert("paperPositions", { candidateId: args.candidateId, symbol: pos.symbol, weight: pos.weight, entryPrice: pos.entryPrice, updatedAt: Date.now() });
    }
    for (const tr of args.trades) await ctx.db.insert("paperTrades", { candidateId: args.candidateId, ...tr });
    return { skipped: false };
  },
});

export const snapshots = query({
  args: { candidateId: v.id("candidates"), sinceTs: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: (ctx, { candidateId, sinceTs, limit }) =>
    ctx.db.query("equitySnapshots")
      .withIndex("by_candidate_ts", (q) => sinceTs ? q.eq("candidateId", candidateId).gte("ts", sinceTs) : q.eq("candidateId", candidateId))
      .order("desc")
      .take(limit ?? 1000),
});

export const recentTrades = query({
  args: { candidateId: v.id("candidates"), limit: v.optional(v.number()) },
  handler: (ctx, { candidateId, limit }) =>
    ctx.db.query("paperTrades").withIndex("by_candidate", (q) => q.eq("candidateId", candidateId)).order("desc").take(limit ?? 50),
});

export const setHalt = mutation({
  args: { candidateId: v.id("candidates"), halted: v.boolean(), reason: v.optional(v.string()) },
  handler: async (ctx, { candidateId, halted, reason }) => {
    const acct = await ctx.db.query("paperAccounts").withIndex("by_candidate", (q) => q.eq("candidateId", candidateId)).first();
    if (acct) await ctx.db.patch(acct._id, { halted, haltReason: reason, updatedAt: Date.now() });
  },
});
