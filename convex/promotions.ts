import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/** Atomic champion swap: archive old champion, crown the new one, log it. */
export const promote = mutation({
  args: { candidateId: v.id("candidates"), approvedBy: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, { candidateId, approvedBy, note }) => {
    const cand = await ctx.db.get(candidateId);
    if (!cand) throw new Error("candidate not found");
    if (!["eligible", "incubating", "demoted"].includes(cand.stage)) throw new Error(`cannot promote from stage ${cand.stage}`);
    const old = await ctx.db.query("candidates").withIndex("by_stage", (q) => q.eq("stage", "champion")).first();
    if (old) await ctx.db.patch(old._id, { stage: "archived", updatedAt: Date.now() });
    await ctx.db.patch(candidateId, { stage: "champion", updatedAt: Date.now() });
    await ctx.db.insert("promotions", {
      candidateId, fromChampionId: old?._id, action: "promote", approvedBy,
      composite: cand.composite, note, createdAt: Date.now(),
    });
    return { replaced: old?._id ?? null };
  },
});

/** Demote current champion (degradation / kill-switch) and revert to the most recent archived champion. */
export const demoteChampion = mutation({
  args: { reason: v.string() },
  handler: async (ctx, { reason }) => {
    const champ = await ctx.db.query("candidates").withIndex("by_stage", (q) => q.eq("stage", "champion")).first();
    if (!champ) return { demoted: null };
    await ctx.db.patch(champ._id, { stage: "demoted", updatedAt: Date.now() });
    await ctx.db.insert("promotions", { candidateId: champ._id, action: "demote", approvedBy: "auto", note: reason, createdAt: Date.now() });
    // revert: newest archived ex-champion
    const archived = await ctx.db.query("candidates").withIndex("by_stage", (q) => q.eq("stage", "archived")).order("desc").first();
    if (archived) {
      await ctx.db.patch(archived._id, { stage: "champion", updatedAt: Date.now() });
      await ctx.db.insert("promotions", { candidateId: archived._id, action: "rollback", approvedBy: "auto", note: `rollback after demotion: ${reason}`, createdAt: Date.now() });
    }
    return { demoted: champ._id, restored: archived?._id ?? null };
  },
});

export const history = query({
  args: { limit: v.optional(v.number()) },
  handler: (ctx, { limit }) =>
    ctx.db.query("promotions").withIndex("by_createdAt").order("desc").take(limit ?? 50),
});
