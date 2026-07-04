// Live-execution accessors. A liveDeployment binds one validated candidate to
// real capital: dryrun (orders computed + logged, never sent) -> live (orders
// sent to the exchange) -> halted (kill-switch or manual). The VPS executor is
// the only writer of run state; these functions keep every transition auditable.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const MODES = new Set(["dryrun", "live", "halted", "off"]);

export const listActive = query({
  args: {},
  handler: async (ctx) => {
    const dry = await ctx.db.query("liveDeployments").withIndex("by_mode", (q) => q.eq("mode", "dryrun")).collect();
    const live = await ctx.db.query("liveDeployments").withIndex("by_mode", (q) => q.eq("mode", "live")).collect();
    return [...live, ...dry];
  },
});

export const listAll = query({
  args: {},
  handler: (ctx) => ctx.db.query("liveDeployments").collect(),
});

export const get = query({
  args: { id: v.id("liveDeployments") },
  handler: (ctx, { id }) => ctx.db.get(id),
});

export const forCandidate = query({
  args: { candidateId: v.id("candidates") },
  handler: (ctx, { candidateId }) =>
    ctx.db.query("liveDeployments").withIndex("by_candidate", (q) => q.eq("candidateId", candidateId)).first(),
});

/** Create a deployment for a candidate (idempotent per candidate). Starts in
 *  dryrun — going live is always an explicit setMode call. */
export const create = mutation({
  args: {
    candidateId: v.id("candidates"),
    capitalUsd: v.number(),
    maxWeight: v.optional(v.number()),
    rebalanceBand: v.optional(v.number()),
    maxDailyLossPct: v.optional(v.number()),
    maxDrawdownPct: v.optional(v.number()),
    symbol: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const existing = await ctx.db.query("liveDeployments").withIndex("by_candidate", (q) => q.eq("candidateId", a.candidateId)).first();
    if (existing) return { id: existing._id, created: false };
    const cand = await ctx.db.get(a.candidateId);
    if (!cand) throw new Error("candidate not found");
    let symbol = a.symbol;
    if (!symbol) {
      try { symbol = (JSON.parse(cand.dsl) as { symbol?: string }).symbol; } catch { /* below */ }
    }
    if (!symbol) throw new Error("candidate has no primary symbol — pass symbol explicitly");
    const now = Date.now();
    const id = await ctx.db.insert("liveDeployments", {
      candidateId: a.candidateId,
      name: cand.name,
      symbol,
      mode: "dryrun",
      capitalUsd: a.capitalUsd,
      maxWeight: Math.min(1, Math.max(0, a.maxWeight ?? 1)),
      rebalanceBand: a.rebalanceBand ?? 0.02,
      maxDailyLossPct: a.maxDailyLossPct ?? 6,
      maxDrawdownPct: a.maxDrawdownPct ?? 25,
      cashUsd: a.capitalUsd,
      baseQty: 0,
      curWeight: 0,
      equityUsd: a.capitalUsd,
      peakEquityUsd: a.capitalUsd,
      createdAt: now,
      updatedAt: now,
    });
    return { id, created: true };
  },
});

/** Flip deployment mode. dryrun->live resets nothing (the dry ledger carries
 *  over as the paper baseline); ->off keeps history but the executor skips it. */
export const setMode = mutation({
  args: { id: v.id("liveDeployments"), mode: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, { id, mode, reason }) => {
    if (!MODES.has(mode)) throw new Error(`bad mode ${mode}`);
    const dep = await ctx.db.get(id);
    if (!dep) throw new Error("deployment not found");
    await ctx.db.patch(id, { mode, haltReason: mode === "halted" ? (reason ?? "manual halt") : undefined, updatedAt: Date.now() });
    return { from: dep.mode, to: mode };
  },
});

/** Executor: persist post-run state + an equity snapshot. */
export const recordRun = mutation({
  args: {
    id: v.id("liveDeployments"),
    ts: v.number(),
    cashUsd: v.number(),
    baseQty: v.number(),
    curWeight: v.number(),
    equityUsd: v.number(),
    price: v.number(),
    dayKey: v.optional(v.string()),
    dayStartEquityUsd: v.optional(v.number()),
    lastTargetTs: v.optional(v.number()),
    halt: v.optional(v.boolean()),
    haltReason: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const dep = await ctx.db.get(a.id);
    if (!dep) throw new Error("deployment not found");
    await ctx.db.patch(a.id, {
      cashUsd: a.cashUsd,
      baseQty: a.baseQty,
      curWeight: a.curWeight,
      equityUsd: a.equityUsd,
      peakEquityUsd: Math.max(dep.peakEquityUsd, a.equityUsd),
      lastRunTs: a.ts,
      ...(a.dayKey !== undefined ? { dayKey: a.dayKey } : {}),
      ...(a.dayStartEquityUsd !== undefined ? { dayStartEquityUsd: a.dayStartEquityUsd } : {}),
      ...(a.lastTargetTs !== undefined ? { lastTargetTs: a.lastTargetTs } : {}),
      ...(a.halt ? { mode: "halted", haltReason: a.haltReason ?? "kill-switch" } : {}),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("liveSnapshots", { deploymentId: a.id, ts: a.ts, equityUsd: a.equityUsd, weight: a.curWeight, price: a.price });
  },
});

export const recordOrder = mutation({
  args: {
    deploymentId: v.id("liveDeployments"),
    ts: v.number(),
    mode: v.string(),
    symbol: v.string(),
    side: v.string(),
    qty: v.number(),
    notionalUsd: v.number(),
    price: v.number(),
    fillPrice: v.optional(v.number()),
    status: v.string(),
    exchangeOrderId: v.optional(v.string()),
    targetWeight: v.number(),
    fromWeight: v.number(),
    note: v.optional(v.string()),
  },
  handler: (ctx, a) => ctx.db.insert("liveOrders", a),
});

/** Executor: patch an order after the exchange responds (intent -> filled/error). */
export const patchOrder = mutation({
  args: {
    id: v.id("liveOrders"),
    status: v.string(),
    qty: v.optional(v.number()),
    notionalUsd: v.optional(v.number()),
    fillPrice: v.optional(v.number()),
    exchangeOrderId: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...rest }) => {
    const patch: Record<string, unknown> = { status: rest.status };
    if (rest.qty !== undefined) patch.qty = rest.qty;
    if (rest.notionalUsd !== undefined) patch.notionalUsd = rest.notionalUsd;
    if (rest.fillPrice !== undefined) patch.fillPrice = rest.fillPrice;
    if (rest.exchangeOrderId !== undefined) patch.exchangeOrderId = rest.exchangeOrderId;
    if (rest.note !== undefined) patch.note = rest.note;
    await ctx.db.patch(id, patch);
  },
});

export const ordersFor = query({
  args: { deploymentId: v.id("liveDeployments"), limit: v.optional(v.number()) },
  handler: (ctx, { deploymentId, limit }) =>
    ctx.db.query("liveOrders").withIndex("by_deployment", (q) => q.eq("deploymentId", deploymentId)).order("desc").take(limit ?? 50),
});

export const snapshotsFor = query({
  args: { deploymentId: v.id("liveDeployments"), limit: v.optional(v.number()) },
  handler: (ctx, { deploymentId, limit }) =>
    ctx.db.query("liveSnapshots").withIndex("by_deployment", (q) => q.eq("deploymentId", deploymentId)).order("desc").take(limit ?? 500),
});

/** Dashboard: all deployments + their recent orders in one shot. */
export const overview = query({
  args: {},
  handler: async (ctx) => {
    const deps = await ctx.db.query("liveDeployments").collect();
    const out = [];
    for (const d of deps) {
      const orders = await ctx.db.query("liveOrders").withIndex("by_deployment", (q) => q.eq("deploymentId", d._id)).order("desc").take(15);
      const snaps = await ctx.db.query("liveSnapshots").withIndex("by_deployment", (q) => q.eq("deploymentId", d._id)).order("desc").take(340);
      snaps.reverse();
      out.push({ ...d, orders, spark: snaps.map((s) => ({ t: s.ts, eq: s.equityUsd })) });
    }
    return out;
  },
});
