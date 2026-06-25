// READ-ONLY dashboard aggregations for the UI. ADDITIVE: no engine/gauntlet
// behavior here, no mutations — these only read existing tables and shape them
// for the precision-instrument dashboard. Safe to delete.

import { v } from "convex/values";
import { query } from "./_generated/server";

// ------------------------------------------------------------------ helpers
function parseMetrics(s?: string): Record<string, number> {
  if (!s) return {};
  try { return JSON.parse(s) as Record<string, number>; } catch { return {}; }
}

/**
 * Iteration progression: every SCORED candidate as {t, composite, source},
 * time-ordered, for the "are we improving over iterations" chart (record line +
 * per-candidate dots colored by source). Reads only candidates that have a
 * composite via the by_composite index — far smaller than the full table, so no
 * 16MB read warning. Trims `dsl`/`metrics`/`curves` off the payload.
 */
export const progression = query({
  args: {},
  handler: async (ctx) => {
    const scored = await ctx.db.query("candidates").withIndex("by_composite").collect();
    const pts = scored
      .filter((r) => r.composite !== undefined && Number.isFinite(r.composite))
      .map((r) => ({ t: r.createdAt, c: r.composite as number, source: r.source, name: r.name }))
      .sort((a, b) => a.t - b.t);
    // cap to the most recent 800 to keep the payload light
    const trimmed = pts.slice(-800);
    let best = -Infinity;
    for (const p of trimmed) if (p.c > best) best = p.c;
    return { points: trimmed, best: best > -Infinity ? best : 0, n: trimmed.length };
  },
});
const oosOf = (m: Record<string, number>) => m.portOosSharpe ?? m.wfPooledSharpe ?? m.oosSharpe;

// alive = anything that survived the gauntlet into the book / paper / crown.
const ALIVE = new Set(["incubating", "eligible", "champion", "sealed_passed"]);

// The canonical ordered gauntlet flow (per-symbol + adapted xsection/iv/oc paths
// are folded into one stage axis so the funnel reads as one pipeline).
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

/**
 * Full pipeline flow: for each ordered stage, how many candidates REACHED it and
 * how many were KILLED there. Reached is computed by walking the kill counts down
 * from the total (every candidate enters at "generated"). Honest: survivors at the
 * tail are the live counts from the stage table.
 */
export const stageFlow = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("candidates").collect();
    const killCount: Record<string, number> = {};
    let penalty = 0;
    const liveStage: Record<string, number> = {};
    for (const r of all) {
      if (r.failedStage) killCount[r.failedStage] = (killCount[r.failedStage] ?? 0) + 1;
      if ((r.failedStage ?? "").startsWith("S1") || (r.failedStage ?? "").startsWith("S0")) penalty++;
      liveStage[r.stage] = (liveStage[r.stage] ?? 0) + 1;
    }
    const total = all.length;
    // reached[generated] = total; each subsequent reached = prev reached - prev killed
    const rows: { key: string; label: string; reached: number; killed: number }[] = [];
    let reached = total - penalty; // S1 penalty-box never entered the gauntlet proper
    for (let i = 0; i < FLOW.length; i++) {
      const f = FLOW[i];
      const killed = f.kills.reduce((s, k) => s + (killCount[k] ?? 0), 0);
      if (f.key === "generated") { rows.push({ key: f.key, label: f.label, reached: total, killed: penalty }); continue; }
      if (f.key === "incubating") { rows.push({ key: f.key, label: f.label, reached: (liveStage.incubating ?? 0), killed: 0 }); continue; }
      if (f.key === "book") { rows.push({ key: f.key, label: f.label, reached: (liveStage.incubating ?? 0), killed: 0 }); continue; }
      if (f.key === "eligible") { rows.push({ key: f.key, label: f.label, reached: (liveStage.eligible ?? 0), killed: 0 }); continue; }
      if (f.key === "champion") { rows.push({ key: f.key, label: f.label, reached: (liveStage.champion ?? 0), killed: 0 }); continue; }
      rows.push({ key: f.key, label: f.label, reached, killed });
      reached -= killed;
    }
    const survivors = (liveStage.incubating ?? 0) + (liveStage.eligible ?? 0) + (liveStage.champion ?? 0) + (liveStage.sealed_passed ?? 0);
    return {
      total,
      penalty,
      survivors,
      killCount,
      inGauntlet: (liveStage.gauntlet ?? 0) + (liveStage.queued ?? 0),
      rows,
      reachedS5: rows.find((r) => r.key === "S5")?.reached ?? 0,
    };
  },
});

/**
 * Per sleeve-FAMILY rollup. Families are the generator lanes that map to distinct
 * alpha sources: per-symbol DSL (gp/llm/mutation/crossover/seed/repair, grouped as
 * "DSL"), cross-sectional (xsection), IV-timing (ivsleeve), on-chain (onchain).
 * For each: total bred, scored, best OOS Sharpe, deepest stage reached, a compact
 * equity sparkline from the best member, and survivor count.
 */
export const sleeveFamilies = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("candidates").collect();
    const FAM: Record<string, string> = {
      gp: "DSL", llm: "DSL", mutation: "DSL", crossover: "DSL", seed: "DSL", repair: "DSL", imported: "DSL",
      xsection: "Cross-sectional", ivsleeve: "IV-timing (DVOL)", onchain: "On-chain (MVRV/NVT)",
    };
    const DESC: Record<string, string> = {
      "DSL": "Per-symbol momentum / mean-reversion / breakout — evolved DSL graphs",
      "Cross-sectional": "Rank trend / carry / basis / OI / LSR / liquidity / size across the universe",
      "IV-timing (DVOL)": "Deribit implied-vol regime timing (orthogonal to price)",
      "On-chain (MVRV/NVT)": "Valuation-timing on MVRV / NVT z-scores (strongest standalone edge)",
    };
    type Agg = {
      family: string; desc: string; bred: number; scored: number; bestOos: number;
      bestName: string; bestCurve?: { t: number[]; eq: number[] }; deepest: string; survivors: number; meanOos: number; oosSum: number; oosN: number;
    };
    const STAGE_DEPTH: Record<string, number> = {
      "S2-train": 2, "S3-walkforward": 3, "S3x-walkforward": 3, "S3iv-walkforward": 3, "S3oc-walkforward": 3,
      "S4-cross-symbol": 4, "S4-portfolio": 4.5, "S4x-portfolio": 4.5,
      "S5-stats": 5, "S5x-stats": 5, "S5iv-stats": 5, "S5oc-stats": 5, "S5b-stress": 5.5, "S5c-pbo": 5.7, "S6-sealed": 6,
    };
    const order = ["DSL", "Cross-sectional", "IV-timing (DVOL)", "On-chain (MVRV/NVT)"];
    const aggs: Record<string, Agg> = {};
    for (const fam of order) aggs[fam] = { family: fam, desc: DESC[fam], bred: 0, scored: 0, bestOos: -99, bestName: "", deepest: "", survivors: 0, meanOos: 0, oosSum: 0, oosN: 0 };
    for (const r of all) {
      const fam = FAM[r.source];
      if (!fam) continue;
      const a = aggs[fam];
      a.bred++;
      if (ALIVE.has(r.stage)) a.survivors++;
      const m = parseMetrics(r.metrics);
      const oos = oosOf(m);
      if (oos !== undefined && Number.isFinite(oos)) {
        a.scored++; a.oosSum += oos; a.oosN++;
        if (oos > a.bestOos) {
          a.bestOos = oos; a.bestName = r.name;
          try {
            const cv = r.curves ? JSON.parse(r.curves) as { wf?: { t: number[]; eq: number[] }; port?: { t: number[]; eq: number[] } } : {};
            a.bestCurve = cv.port ?? cv.wf;
          } catch { /* ignore */ }
        }
      }
      const depth = STAGE_DEPTH[r.failedStage ?? ""] ?? (ALIVE.has(r.stage) ? 8 : 0);
      const curDepth = STAGE_DEPTH[a.deepest] ?? (a.deepest === "alive" ? 8 : 0);
      if (depth > curDepth) a.deepest = ALIVE.has(r.stage) && depth === 8 ? "alive" : (r.failedStage ?? a.deepest);
    }
    return order.map((fam) => {
      const a = aggs[fam];
      return {
        family: a.family, desc: a.desc, bred: a.bred, scored: a.scored,
        bestOos: a.bestOos > -99 ? a.bestOos : null, bestName: a.bestName,
        bestCurve: a.bestCurve, deepest: a.deepest || "—", survivors: a.survivors,
        meanOos: a.oosN ? a.oosSum / a.oosN : null,
      };
    });
  },
});

/**
 * Book status for the headline panel. The book row stores raw OOS stats + mean
 * |corr|. The DEFLATED book Sharpe is the binding promotion bar (needs >= 1.0);
 * the most recent honest value is the book-gate's deflated estimate persisted on
 * any book-admitted candidate's metrics, else (empty book) it is 0.0. We return
 * the raw, deflated, divRatio, meanCorr, members + the explicit progress-to-1.0.
 */
export const bookStatus = query({
  args: {},
  handler: async (ctx) => {
    const book = await ctx.db.query("book").withIndex("by_key", (q) => q.eq("key", "current")).first();
    // scan recent candidates for the latest persisted book-gate snapshot
    const recent = await ctx.db.query("candidates").order("desc").take(400);
    let snap: { bookSharpe: number; bookDeflated: number; bookDivRatio: number; maxBookCorr: number; at: number } | null = null;
    for (const r of recent) {
      const m = parseMetrics(r.metrics);
      if (m.bookDeflated !== undefined) {
        if (!snap || r.updatedAt > snap.at) {
          snap = { bookSharpe: m.bookSharpe ?? 0, bookDeflated: m.bookDeflated, bookDivRatio: m.bookDivRatio ?? 1, maxBookCorr: m.maxBookCorr ?? 0, at: r.updatedAt };
        }
      }
    }
    const nMembers = book?.nMembers ?? 0;
    const rawSharpe = nMembers > 0 ? (book?.stats.sharpe ?? 0) : (snap?.bookSharpe ?? 0);
    const deflated = snap?.bookDeflated ?? 0;       // honest: 0 when book empty / never gated
    const divRatio = snap?.bookDivRatio ?? (book ? 1 : 0);
    const meanCorr = book?.meanAbsCorr ?? snap?.maxBookCorr ?? 0;
    const target = 1.0;
    return {
      nMembers,
      rawSharpe,
      deflated,
      divRatio,
      meanCorr,
      target,
      progress: Math.max(0, Math.min(1, deflated / target)),
      passes: deflated >= target && rawSharpe >= 1.0 && meanCorr <= 0.5,
      members: (book?.members ?? []).map((m) => ({ name: m.name, weight: m.weight, riskContrib: m.riskContrib, standaloneSharpe: m.standaloneSharpe })),
      stats: book?.stats ?? { sharpe: 0, vol: 0, maxDD: 0, meanRet: 0, nBars: 0 },
      updatedAt: book?.updatedAt ?? 0,
    };
  },
});

/**
 * Data sources + freshness for the Data/System page. Price/funding coverage comes
 * from the datasets table; the new orthogonal feeds (DVOL, on-chain, stablecoins)
 * are reported by presence of their generator families + a static descriptor since
 * they live in R2, not the datasets table.
 */
export const dataSources = query({
  args: {},
  handler: async (ctx) => {
    const datasets = await ctx.db.query("datasets").collect();
    const symbols = [...new Set(datasets.map((d) => d.symbol))];
    const tfs = [...new Set(datasets.map((d) => d.tf))];
    const lastTs = datasets.length ? Math.max(...datasets.map((d) => d.lastTs)) : 0;
    const fundingTs = datasets.length ? Math.max(...datasets.map((d) => d.fundingLastTs ?? 0)) : 0;
    const totalBars = datasets.reduce((s, d) => s + d.bars, 0);
    const totalGaps = datasets.reduce((s, d) => s + d.gaps, 0);
    // which orthogonal lanes have produced candidates (evidence the feed is wired)
    const cands = await ctx.db.query("candidates").take(2000);
    const srcSeen = new Set(cands.map((c) => c.source));
    return {
      price: { symbols: symbols.length, tfs, lastTs, totalBars, totalGaps, rows: datasets.length },
      funding: { lastTs: fundingTs },
      orthogonal: [
        { key: "perp", label: "Perp OHLCV + funding (OKX via ccxt)", live: true, note: `${symbols.length} symbols × ${tfs.length} tf` },
        { key: "basis_oi_lsr", label: "Basis / OI / LSR (Binance futures)", live: srcSeen.has("xsection"), note: "cross-sectional features" },
        { key: "dvol", label: "Implied vol — DVOL (Deribit)", live: srcSeen.has("ivsleeve"), note: "BTC/ETH ~1850d" },
        { key: "onchain", label: "On-chain — MVRV / NVT / addr / netflow (Coin Metrics)", live: srcSeen.has("onchain"), note: "BTC/ETH ~5y, lagged 1d" },
        { key: "stables", label: "Stablecoin supply (DeFiLlama)", live: srcSeen.has("onchain"), note: "lagged 1d" },
      ],
      symbols,
    };
  },
});

/**
 * PAPER BOOK — the live forward-test track record (the moving headline). Every
 * incubating/eligible/champion sleeve is paper-traded forward hourly. We return:
 *  - per-sleeve forward equity/return/Sharpe/days/maxDD (which hold up vs decay),
 *  - the COMBINED equal-weight paper-book equity curve + forward Sharpe.
 * PAPER = simulated, no real money. Forward Sharpe shown only once enough bars
 * exist ("warming" otherwise) — honest about how young the track record is.
 */
export const paperBook = query({
  args: {},
  handler: async (ctx) => {
    const stages = ["incubating", "eligible", "champion"];
    const sleeves: { id: string; name: string; source: string; family: string; forwardSeed: boolean; startEq: number; equity: number; peak: number; days: number; ret: number; sharpe: number | null; maxDD: number; halted: boolean; bars: number; spark: number[] }[] = [];
    const PPY = 8760; // hourly paper steps
    const fam = (s: string) => s === "xsection" ? "Cross-sectional" : s === "ivsleeve" ? "IV-timing" : s === "onchain" ? "On-chain" : "DSL";
    // collect all snapshots keyed by timestamp for the combined book curve
    const perTsRet = new Map<number, { sum: number; n: number }>();

    for (const stage of stages) {
      const rows = await ctx.db.query("candidates").withIndex("by_stage", (q) => q.eq("stage", stage)).collect();
      for (const c of rows) {
        const acct = await ctx.db.query("paperAccounts").withIndex("by_candidate", (q) => q.eq("candidateId", c._id)).first();
        if (!acct) continue;
        const snaps = (await ctx.db.query("equitySnapshots").withIndex("by_candidate_ts", (q) => q.eq("candidateId", c._id)).order("asc").take(2000));
        const rets = snaps.map((s) => s.ret).filter((r) => Number.isFinite(r));
        const eqs = snaps.map((s) => s.equity);
        const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
        const sd = rets.length ? Math.sqrt(Math.max(0, rets.reduce((a, b) => a + b * b, 0) / rets.length - mean * mean)) : 0;
        const sharpe = rets.length > 48 && sd > 1e-12 ? (mean / sd) * Math.sqrt(PPY) : null;
        let peak = 10000, maxDD = 0;
        for (const e of eqs) { peak = Math.max(peak, e); maxDD = Math.min(maxDD, peak > 0 ? e / peak - 1 : 0); }
        const m = parseMetrics(c.metrics);
        const startedAt = c.incubationStartedAt ?? acct.startedAt ?? Date.now();
        sleeves.push({
          id: c._id, name: c.name, source: c.source, family: fam(c.source), forwardSeed: m.forwardPaper === 1 || m.forwardPaperSeed === 1,
          startEq: 10000, equity: acct.equity, peak: acct.peakEquity ?? peak,
          days: (Date.now() - startedAt) / 86400_000, ret: (acct.equity / (10000)) - 1,
          sharpe, maxDD, halted: !!acct.halted, bars: rets.length,
          spark: eqs.slice(-60),
        });
        // accumulate equal-weight book returns by timestamp
        for (const s of snaps) {
          const slot = perTsRet.get(s.ts) ?? { sum: 0, n: 0 };
          slot.sum += s.ret; slot.n += 1; perTsRet.set(s.ts, slot);
        }
      }
    }

    // combined equal-weight book equity curve
    const tsSorted = [...perTsRet.keys()].sort((a, b) => a - b);
    const bookT: number[] = [], bookEq: number[] = []; const bookRets: number[] = [];
    let eq = 1;
    for (const ts of tsSorted) {
      const slot = perTsRet.get(ts)!;
      const r = slot.n ? slot.sum / slot.n : 0; // equal-weight average sleeve return this step
      eq *= 1 + r; bookT.push(ts); bookEq.push(eq); bookRets.push(r);
    }
    const bMean = bookRets.length ? bookRets.reduce((a, b) => a + b, 0) / bookRets.length : 0;
    const bSd = bookRets.length ? Math.sqrt(Math.max(0, bookRets.reduce((a, b) => a + b * b, 0) / bookRets.length - bMean * bMean)) : 0;
    const bookSharpe = bookRets.length > 48 && bSd > 1e-12 ? (bMean / bSd) * Math.sqrt(PPY) : null;
    let bookPeak = 1, bookDD = 0;
    for (const e of bookEq) { bookPeak = Math.max(bookPeak, e); bookDD = Math.min(bookDD, e / bookPeak - 1); }
    const days = sleeves.length ? Math.max(...sleeves.map((s) => s.days)) : 0;

    sleeves.sort((a, b) => (b.sharpe ?? -99) - (a.sharpe ?? -99));
    return {
      nSleeves: sleeves.length,
      days,
      book: { t: bookT, eq: bookEq, sharpe: bookSharpe, ret: bookEq.length ? bookEq[bookEq.length - 1] - 1 : 0, maxDD: bookDD, bars: bookRets.length },
      sleeves,
    };
  },
});
