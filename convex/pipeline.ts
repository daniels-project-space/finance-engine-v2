import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ---------- gate reports ----------
export const addGateReport = mutation({
  args: { candidateId: v.id("candidates"), stage: v.string(), passed: v.boolean(), reason: v.optional(v.string()), report: v.string(), durationMs: v.number() },
  handler: (ctx, args) => ctx.db.insert("gateReports", { ...args, createdAt: Date.now() }),
});

export const reportsFor = query({
  args: { candidateId: v.id("candidates") },
  handler: (ctx, { candidateId }) =>
    ctx.db.query("gateReports").withIndex("by_candidate", (q) => q.eq("candidateId", candidateId)).collect(),
});

// ---------- lessons ----------
export const addLesson = mutation({
  args: { source: v.string(), text: v.string(), candidateId: v.optional(v.id("candidates")), stage: v.optional(v.string()) },
  handler: (ctx, args) => ctx.db.insert("lessons", { ...args, createdAt: Date.now() }),
});

export const recentLessons = query({
  args: { limit: v.optional(v.number()) },
  handler: (ctx, { limit }) =>
    ctx.db.query("lessons").withIndex("by_createdAt").order("desc").take(limit ?? 30),
});

// ---------- penalty box ----------
export const penalize = mutation({
  args: { familyHash: v.string(), reason: v.string(), days: v.number() },
  handler: (ctx, { familyHash, reason, days }) =>
    ctx.db.insert("penaltyBox", { familyHash, reason, until: Date.now() + days * 86400_000, createdAt: Date.now() }),
});

// Clear all penalty-box rows for a family. Reversible: the family re-accrues a
// 7-day penalty the next time a candidate of it fails with familySeen >= 4, so this
// is a selective unblock, not a permanent exemption. Returns the count removed.
export const clearPenalty = mutation({
  args: { familyHash: v.string() },
  handler: async (ctx, { familyHash }) => {
    const rows = await ctx.db.query("penaltyBox").withIndex("by_family", (q) => q.eq("familyHash", familyHash)).collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return rows.length;
  },
});

export const isPenalized = query({
  args: { familyHash: v.string() },
  handler: async (ctx, { familyHash }) => {
    const rows = await ctx.db.query("penaltyBox").withIndex("by_family", (q) => q.eq("familyHash", familyHash)).collect();
    return rows.some((r) => r.until > Date.now());
  },
});

// ---------- sealed holdout (one-shot) ----------
export const claimHoldout = mutation({
  args: { hash: v.string(), sealTs: v.number() },
  handler: async (ctx, { hash, sealTs }) => {
    const existing = await ctx.db.query("holdoutRuns").withIndex("by_hash", (q) => q.eq("hash", hash)).first();
    if (existing) return { allowed: false, prior: existing.result };
    await ctx.db.insert("holdoutRuns", { hash, sealTs, result: "pending", passed: false, createdAt: Date.now() });
    return { allowed: true };
  },
});

export const recordHoldout = mutation({
  args: { hash: v.string(), result: v.string(), passed: v.boolean() },
  handler: async (ctx, { hash, result, passed }) => {
    const row = await ctx.db.query("holdoutRuns").withIndex("by_hash", (q) => q.eq("hash", hash)).first();
    if (row) await ctx.db.patch(row._id, { result, passed });
  },
});

// ---------- counters (budgets, trial counts) ----------
export const bumpCounter = mutation({
  args: { key: v.string(), by: v.number() },
  handler: async (ctx, { key, by }) => {
    const row = await ctx.db.query("counters").withIndex("by_key", (q) => q.eq("key", key)).first();
    if (row) { await ctx.db.patch(row._id, { value: row.value + by }); return row.value + by; }
    await ctx.db.insert("counters", { key, value: by });
    return by;
  },
});

export const getCounter = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) =>
    (await ctx.db.query("counters").withIndex("by_key", (q) => q.eq("key", key)).first())?.value ?? 0,
});

// ---------- runs ----------
export const startRun = mutation({
  args: { kind: v.string() },
  handler: (ctx, { kind }) => ctx.db.insert("runs", { kind, status: "running", startedAt: Date.now() }),
});

export const finishRun = mutation({
  args: { id: v.id("runs"), status: v.string(), summary: v.optional(v.string()) },
  handler: (ctx, { id, status, summary }) => ctx.db.patch(id, { status, summary, finishedAt: Date.now() }),
});

export const recentRuns = query({
  args: { limit: v.optional(v.number()) },
  handler: (ctx, { limit }) => ctx.db.query("runs").order("desc").take(limit ?? 30),
});

// ---------- datasets ----------
export const upsertDataset = mutation({
  args: { symbol: v.string(), tf: v.string(), firstTs: v.number(), lastTs: v.number(), bars: v.number(), gaps: v.number(), fundingLastTs: v.optional(v.number()), r2Key: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("datasets").withIndex("by_symbol_tf", (q) => q.eq("symbol", args.symbol).eq("tf", args.tf)).first();
    if (row) await ctx.db.patch(row._id, { ...args, updatedAt: Date.now() });
    else await ctx.db.insert("datasets", { ...args, updatedAt: Date.now() });
  },
});

export const listDatasets = query({ args: {}, handler: (ctx) => ctx.db.query("datasets").collect() });

// ---------- config ----------
export const getConfig = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) =>
    (await ctx.db.query("config").withIndex("by_key", (q) => q.eq("key", key)).first())?.json ?? null,
});

export const setConfig = mutation({
  args: { key: v.string(), json: v.string() },
  handler: async (ctx, { key, json }) => {
    const row = await ctx.db.query("config").withIndex("by_key", (q) => q.eq("key", key)).first();
    if (row) await ctx.db.patch(row._id, { json });
    else await ctx.db.insert("config", { key, json });
  },
});

export const getAgentProvider = query({
  args: {},
  handler: async (ctx) => {
    const value = (await ctx.db.query("config").withIndex("by_key", (q) => q.eq("key", "agent_provider")).first())?.json;
    return value === "claude" ? "claude" : "codex";
  },
});

export const setAgentProvider = mutation({
  args: { provider: v.union(v.literal("codex"), v.literal("claude")) },
  handler: async (ctx, { provider }) => {
    const row = await ctx.db.query("config").withIndex("by_key", (q) => q.eq("key", "agent_provider")).first();
    if (row) await ctx.db.patch(row._id, { json: provider });
    else await ctx.db.insert("config", { key: "agent_provider", json: provider });
    return provider;
  },
});
