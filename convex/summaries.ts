// Materialized dashboard aggregates. The candidates table outgrew Convex's 16MB
// single-execution read limit, so anything that used to full-scan it (stage
// flow, family rollups, progression) is precomputed here by a PAGINATED internal
// action on a Convex cron and stored as one small `summaries` row per key. The
// dashboard queries read the row — O(1) regardless of table growth.
//
// Also owns retention: failed candidates older than PRUNE_AGE_DAYS lose their
// fat `curves` JSON (metrics kept) unless they are in the top-N by composite —
// keeps the table scannable and the tournament near-miss charts intact.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { api, internal } from "./_generated/api";

const PAGE = 50;                  // docs per paginated read (bounded bytes per execution)
const PRUNE_AGE_DAYS = 14;
const PRUNE_KEEP_TOP = 150;

// ------------------------------------------------------------------ helpers
const oosOf = (m: Record<string, number>) => m.portOosSharpe ?? m.wfPooledSharpe ?? m.oosSharpe;
const ALIVE = new Set(["incubating", "eligible", "champion", "sealed_passed"]);

const FLOW: { key: string; label: string; kills: string[] }[] = [
  { key: "generated", label: "Generated", kills: [] },
  { key: "S2", label: "S2 · Train fit", kills: ["S2-train"] },
  { key: "S3", label: "S3 · Walk-forward", kills: ["S3-walkforward", "S3x-walkforward", "S3iv-walkforward", "S3oc-walkforward"] },
  { key: "S4", label: "S4 · Cross-symbol / portfolio", kills: ["S4-cross-symbol", "S4-portfolio", "S4x-portfolio"] },
  { key: "S5", label: "S5 · Stats / DSR", kills: ["S5-stats", "S5x-stats", "S5iv-stats", "S5oc-stats"] },
  { key: "S5b", label: "S5b · Stress", kills: ["S5b-stress"] },
  { key: "S5c", label: "S5c · PBO", kills: ["S5c-pbo"] },
  { key: "S6", label: "S6 · Sealed holdout", kills: ["S6-sealed"] },
  { key: "incubating", label: "Incubating (paper)", kills: [] },
  { key: "book", label: "Book", kills: [] },
  { key: "eligible", label: "Eligible", kills: [] },
  { key: "champion", label: "Champion", kills: [] },
];

const FAM: Record<string, string> = {
  gp: "DSL", llm: "DSL", mutation: "DSL", crossover: "DSL", seed: "DSL", repair: "DSL", imported: "DSL", regime: "DSL",
  xsection: "Cross-sectional", ivsleeve: "IV-timing (DVOL)", onchain: "On-chain (MVRV/NVT)",
  combination: "Combination", trendbeta: "Trend-beta", blend: "Blend (manual)",
};
const DESC: Record<string, string> = {
  "DSL": "Per-symbol momentum / mean-reversion / breakout — evolved DSL graphs",
  "Cross-sectional": "Rank trend / carry / basis / OI / LSR / liquidity / size across the universe",
  "IV-timing (DVOL)": "Deribit implied-vol regime timing (orthogonal to price)",
  "On-chain (MVRV/NVT)": "Valuation-timing on MVRV / NVT z-scores (strongest standalone edge)",
  "Combination": "Machine-composed portfolios + regime overlays of proven blocks",
  "Trend-beta": "Long-flat SMA trend baselines",
  "Blend (manual)": "Daniel's on-chain 70/30 blends (hand-built, gauntlet-scored)",
};
const FAMILY_ORDER = ["DSL", "Combination", "Cross-sectional", "IV-timing (DVOL)", "On-chain (MVRV/NVT)", "Trend-beta", "Blend (manual)"];
const STAGE_DEPTH: Record<string, number> = {
  "S2-train": 2, "S3-walkforward": 3, "S3x-walkforward": 3, "S3iv-walkforward": 3, "S3oc-walkforward": 3,
  "S4-cross-symbol": 4, "S4-portfolio": 4.5, "S4x-portfolio": 4.5,
  "S5-stats": 5, "S5x-stats": 5, "S5iv-stats": 5, "S5oc-stats": 5, "S5b-stress": 5.5, "S5c-pbo": 5.7, "S6-sealed": 6,
};

// ------------------------------------------------------------------ plumbing
export const get = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const row = await ctx.db.query("summaries").withIndex("by_key", (q) => q.eq("key", key)).first();
    return row ? { json: row.json, updatedAt: row.updatedAt } : null;
  },
});

export const write = internalMutation({
  args: { key: v.string(), json: v.string() },
  handler: async (ctx, { key, json }) => {
    const existing = await ctx.db.query("summaries").withIndex("by_key", (q) => q.eq("key", key)).first();
    if (existing) await ctx.db.patch(existing._id, { json, updatedAt: Date.now() });
    else await ctx.db.insert("summaries", { key, json, updatedAt: Date.now() });
  },
});

/** One page of candidates, PROJECTED to the tiny fields the aggregator needs —
 *  each execution reads at most PAGE full docs, far under the byte limit. */
export const page = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const res = await ctx.db.query("candidates").paginate({ cursor, numItems: PAGE });
    return {
      isDone: res.isDone,
      continueCursor: res.continueCursor,
      rows: res.page.map((r) => {
        let oos: number | undefined;
        if (r.metrics) { try { oos = oosOf(JSON.parse(r.metrics) as Record<string, number>); } catch { /* skip */ } }
        return {
          id: r._id as string,
          stage: r.stage,
          failedStage: r.failedStage ?? null,
          source: r.source,
          name: r.name,
          composite: r.composite ?? null,
          createdAt: r.createdAt,
          oos: oos !== undefined && Number.isFinite(oos) ? oos : null,
          hasCurves: r.curves !== undefined,
        };
      }),
    };
  },
});

export const curvesOf = internalQuery({
  args: { id: v.id("candidates") },
  handler: async (ctx, { id }) => {
    const r = await ctx.db.get(id);
    if (!r?.curves) return null;
    try {
      const cv = JSON.parse(r.curves) as { wf?: { t: number[]; eq: number[] }; port?: { t: number[]; eq: number[] } };
      return cv.port ?? cv.wf ?? null;
    } catch { return null; }
  },
});

export const topCompositeIds = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db.query("candidates").withIndex("by_composite").order("desc").take(limit);
    return rows.map((r) => r._id as string);
  },
});

export const stripCurves = internalMutation({
  args: { ids: v.array(v.id("candidates")) },
  handler: async (ctx, { ids }) => {
    for (const id of ids) await ctx.db.patch(id, { curves: undefined });
    return ids.length;
  },
});

// ------------------------------------------------------------------ rebuild
export const rebuild = internalAction({
  args: {},
  handler: async (ctx): Promise<{ total: number; families: number; scored: number }> => {
    // one paginated pass accumulates everything the three dashboard reads need
    const killCount: Record<string, number> = {};
    const liveStage: Record<string, number> = {};
    let total = 0, penalty = 0;
    type Agg = { bred: number; scored: number; bestOos: number; bestName: string; bestId: string; deepest: string; survivors: number; oosSum: number; oosN: number };
    const aggs: Record<string, Agg> = {};
    for (const fam of FAMILY_ORDER) aggs[fam] = { bred: 0, scored: 0, bestOos: -99, bestName: "", bestId: "", deepest: "", survivors: 0, oosSum: 0, oosN: 0 };
    const progression: { t: number; c: number; source: string; name: string }[] = [];

    let cursor: string | null = null;
    for (;;) {
      const res: { isDone: boolean; continueCursor: string; rows: { id: string; stage: string; failedStage: string | null; source: string; name: string; composite: number | null; createdAt: number; oos: number | null }[] } =
        await ctx.runQuery(internal.summaries.page, { cursor });
      for (const r of res.rows) {
        total++;
        if (r.failedStage) killCount[r.failedStage] = (killCount[r.failedStage] ?? 0) + 1;
        if ((r.failedStage ?? "").startsWith("S1") || (r.failedStage ?? "").startsWith("S0")) penalty++;
        liveStage[r.stage] = (liveStage[r.stage] ?? 0) + 1;
        if (r.composite !== null && Number.isFinite(r.composite)) progression.push({ t: r.createdAt, c: r.composite, source: r.source, name: r.name });
        const fam = FAM[r.source];
        if (fam) {
          const a = aggs[fam];
          a.bred++;
          if (ALIVE.has(r.stage)) a.survivors++;
          if (r.oos !== null) {
            a.scored++; a.oosSum += r.oos; a.oosN++;
            if (r.oos > a.bestOos) { a.bestOos = r.oos; a.bestName = r.name; a.bestId = r.id; }
          }
          const depth = STAGE_DEPTH[r.failedStage ?? ""] ?? (ALIVE.has(r.stage) ? 8 : 0);
          const curDepth = STAGE_DEPTH[a.deepest] ?? (a.deepest === "alive" ? 8 : 0);
          if (depth > curDepth) a.deepest = ALIVE.has(r.stage) && depth === 8 ? "alive" : (r.failedStage ?? a.deepest);
        }
      }
      if (res.isDone) break;
      cursor = res.continueCursor;
    }

    // ---- stageFlow (same shape the widget always consumed) ----
    const rows: { key: string; label: string; reached: number; killed: number }[] = [];
    let reached = total - penalty;
    for (const f of FLOW) {
      const killed = f.kills.reduce((s, k) => s + (killCount[k] ?? 0), 0);
      if (f.key === "generated") { rows.push({ key: f.key, label: f.label, reached: total, killed: penalty }); continue; }
      if (f.key === "incubating" || f.key === "book") { rows.push({ key: f.key, label: f.label, reached: liveStage.incubating ?? 0, killed: 0 }); continue; }
      if (f.key === "eligible") { rows.push({ key: f.key, label: f.label, reached: liveStage.eligible ?? 0, killed: 0 }); continue; }
      if (f.key === "champion") { rows.push({ key: f.key, label: f.label, reached: liveStage.champion ?? 0, killed: 0 }); continue; }
      rows.push({ key: f.key, label: f.label, reached, killed });
      reached -= killed;
    }
    const stageFlow = {
      total, penalty,
      survivors: (liveStage.incubating ?? 0) + (liveStage.eligible ?? 0) + (liveStage.champion ?? 0) + (liveStage.sealed_passed ?? 0),
      killCount,
      inGauntlet: (liveStage.gauntlet ?? 0) + (liveStage.queued ?? 0),
      rows,
      reachedS5: rows.find((r) => r.key === "S5")?.reached ?? 0,
    };

    // ---- sleeveFamilies (fetch only the best member's curve per family) ----
    const families = [];
    for (const fam of FAMILY_ORDER) {
      const a = aggs[fam];
      let bestCurve: { t: number[]; eq: number[] } | null = null;
      if (a.bestId) {
        try { bestCurve = await ctx.runQuery(internal.summaries.curvesOf, { id: a.bestId as never }); } catch { /* pruned */ }
      }
      families.push({
        family: fam, desc: DESC[fam], bred: a.bred, scored: a.scored,
        bestOos: a.bestOos > -99 ? a.bestOos : null, bestName: a.bestName,
        bestCurve: bestCurve ?? undefined, deepest: a.deepest || "—", survivors: a.survivors,
        meanOos: a.oosN ? a.oosSum / a.oosN : null,
      });
    }

    // ---- progression (record line + recent dots) ----
    progression.sort((a, b) => a.t - b.t);
    const trimmed = progression.slice(-800);
    let best = -Infinity;
    for (const p of trimmed) if (p.c > best) best = p.c;

    await ctx.runMutation(internal.summaries.write, { key: "stageFlow", json: JSON.stringify(stageFlow) });
    await ctx.runMutation(internal.summaries.write, { key: "sleeveFamilies", json: JSON.stringify(families) });
    await ctx.runMutation(internal.summaries.write, { key: "progression", json: JSON.stringify({ points: trimmed, best: best > -Infinity ? best : 0, n: trimmed.length }) });

    // 2026-07-07 — wrap-and-cache the live dashboard queries (paperBook /
    // bookStatus / dataSources). They previously re-ran on EVERY candidates write
    // (N+1 + take(2000)/take(400) scans of fat metrics/curves JSON); now the
    // dashboard reads these O(1) summaries rows and only this hourly cron pays the
    // scan. One failing cache must not break the core rebuild above.
    for (const [key, fn] of [
      ["dash_paperBook", api.dashboard.paperBook],
      ["dash_bookStatus", api.dashboard.bookStatus],
      ["dash_dataSources", api.dashboard.dataSources],
    ] as const) {
      try {
        const data = await ctx.runQuery(fn, { _bypassCache: true });
        await ctx.runMutation(internal.summaries.write, { key, json: JSON.stringify(data) });
      } catch { /* skip a failing dashboard cache; core summaries already written */ }
    }
    return { total, families: families.length, scored: trimmed.length };
  },
});

// ------------------------------------------------------------------ retention
export const prune = internalAction({
  args: {},
  handler: async (ctx): Promise<{ stripped: number }> => {
    const keep = new Set(await ctx.runQuery(internal.summaries.topCompositeIds, { limit: PRUNE_KEEP_TOP }));
    const cutoff = Date.now() - PRUNE_AGE_DAYS * 86400_000;
    let cursor: string | null = null;
    let stripped = 0;
    for (;;) {
      const res: { isDone: boolean; continueCursor: string; rows: { id: string; stage: string; createdAt: number; hasCurves: boolean }[] } =
        await ctx.runQuery(internal.summaries.page, { cursor });
      const ids = res.rows
        .filter((r) => r.hasCurves && r.stage === "failed" && r.createdAt < cutoff && !keep.has(r.id))
        .map((r) => r.id);
      for (let i = 0; i < ids.length; i += 25) {
        stripped += await ctx.runMutation(internal.summaries.stripCurves, { ids: ids.slice(i, i + 25) as never });
      }
      if (res.isDone) break;
      cursor = res.continueCursor;
    }
    return { stripped };
  },
});
