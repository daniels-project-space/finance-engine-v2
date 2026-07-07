// READ-ONLY dashboard aggregations for the UI. ADDITIVE: no engine/gauntlet
// behavior here, no mutations — these only read existing tables and shape them
// for the precision-instrument dashboard. Safe to delete.

import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";

// ------------------------------------------------------------------ helpers
function parseMetrics(s?: string): Record<string, number> {
  if (!s) return {};
  try { return JSON.parse(s) as Record<string, number>; } catch { return {}; }
}

// The candidates table outgrew Convex's 16MB single-execution read limit, so
// progression / stageFlow / sleeveFamilies no longer scan it here. They read the
// materialized `summaries` rows rebuilt every 15 min by convex/summaries.ts.
async function readSummary<T>(ctx: QueryCtx, key: string): Promise<T | null> {
  const row = await ctx.db.query("summaries").withIndex("by_key", (q) => q.eq("key", key)).first();
  if (!row) return null;
  try { return JSON.parse(row.json) as T; } catch { return null; }
}

/**
 * Iteration progression: every SCORED candidate as {t, composite, source},
 * time-ordered, for the "are we improving over iterations" chart. Materialized.
 */
interface ProgressionShape { points: { t: number; c: number; source: string; name: string }[]; best: number; n: number }
export const progression = query({
  args: {},
  handler: async (ctx): Promise<ProgressionShape> =>
    (await readSummary<ProgressionShape>(ctx, "progression")) ?? { points: [], best: 0, n: 0 },
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
interface StageFlowShape {
  total: number; penalty: number; survivors: number; killCount: Record<string, number>;
  inGauntlet: number; rows: { key: string; label: string; reached: number; killed: number }[]; reachedS5: number;
}
export const stageFlow = query({
  args: {},
  handler: async (ctx): Promise<StageFlowShape> =>
    (await readSummary<StageFlowShape>(ctx, "stageFlow")) ?? {
      total: 0, penalty: 0, survivors: 0, killCount: {}, inGauntlet: 0,
      rows: FLOW.map((f) => ({ key: f.key, label: f.label, reached: 0, killed: 0 })),
      reachedS5: 0,
    },
});

/**
 * Per sleeve-FAMILY rollup. Families are the generator lanes that map to distinct
 * alpha sources: per-symbol DSL (gp/llm/mutation/crossover/seed/repair, grouped as
 * "DSL"), cross-sectional (xsection), IV-timing (ivsleeve), on-chain (onchain).
 * For each: total bred, scored, best OOS Sharpe, deepest stage reached, a compact
 * equity sparkline from the best member, and survivor count.
 */
interface FamilyShape {
  family: string; desc: string; bred: number; scored: number; bestOos: number | null;
  bestName: string; bestCurve?: { t: number[]; eq: number[] }; deepest: string;
  survivors: number; meanOos: number | null;
}
export const sleeveFamilies = query({
  args: {},
  handler: async (ctx): Promise<FamilyShape[]> =>
    (await readSummary<FamilyShape[]>(ctx, "sleeveFamilies")) ?? [],
});

/**
 * Book status for the headline panel. The book row stores raw OOS stats + mean
 * |corr|. The DEFLATED book Sharpe is the binding promotion bar (needs >= 1.0);
 * the most recent honest value is the book-gate's deflated estimate persisted on
 * any book-admitted candidate's metrics, else (empty book) it is 0.0. We return
 * the raw, deflated, divRatio, meanCorr, members + the explicit progress-to-1.0.
 */
export const bookStatus = query({
  args: { _bypassCache: v.optional(v.boolean()) },
  handler: async (ctx, { _bypassCache }) => {
    // Cached path — one summaries row written hourly by summaries.rebuild. The
    // live compute below scans candidates.take(400) and re-ran on every candidate
    // write; the cache makes the dashboard read O(1). Cold → live fallback.
    if (!_bypassCache) {
      const cached = await ctx.db.query("summaries").withIndex("by_key", (q) => q.eq("key", "dash_bookStatus")).first();
      if (cached) return JSON.parse(cached.json);
    }
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
    // Source set materialized by summaries.rebuild's single full pass — was a
    // candidates.take(2000) of 33 KB docs (~66 MB) on every reactive call.
    const seenRow = await ctx.db.query("summaries").withIndex("by_key", (q) => q.eq("key", "sourcesSeen")).first();
    const srcSeen = new Set<string>(seenRow ? (JSON.parse(seenRow.json) as string[]) : []);
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
  args: { _bypassCache: v.optional(v.boolean()) },
  handler: async (ctx, { _bypassCache }) => {
    // Cached path — hourly summaries row. The live compute below does an N+1 over
    // every incubating/eligible/champion sleeve, each reading up to 2000 equity
    // snapshots, and re-ran on EVERY candidate write. Paper steps are hourly, so a
    // 60-min cache loses no freshness. Cold → live fallback.
    if (!_bypassCache) {
      const cached = await ctx.db.query("summaries").withIndex("by_key", (q) => q.eq("key", "dash_paperBook")).first();
      if (cached) return JSON.parse(cached.json);
    }
    const stages = ["incubating", "eligible", "champion"];
    const sleeves: { id: string; name: string; source: string; family: string; forwardSeed: boolean; userStrategy?: boolean; flagship?: boolean; lastTs?: number; leverage?: number; legs?: { symbol: string; long: boolean }[]; startEq: number; equity: number; peak: number; days: number; ret: number; sharpe: number | null; maxDD: number; halted: boolean; bars: number; spark: number[]; backtestTotal?: number; backtestHodlTotal?: number; vsHodl?: { trendCagr: number; trendMaxDD: number; trendCalmar: number; hodlCagr: number; hodlMaxDD: number; hodlCalmar: number } }[] = [];
    const PPY = 8760; // hourly paper steps
    const fam = (s: string) => s === "xsection" ? "Cross-sectional" : s === "ivsleeve" ? "IV-timing" : s === "onchain" ? "On-chain" : s === "trendbeta" ? "Trend-beta" : s === "blend" ? "Blend (on-chain + trend)" : s === "regime" ? "Regime / chop" : "DSL";
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
        // CORE-4 flagship: surface its per-coin long/flat legs for the live card.
        let legs: { symbol: string; long: boolean }[] | undefined;
        const isFlagship = m.flagship === 1;
        if (isFlagship) {
          const pos = await ctx.db.query("paperPositions").withIndex("by_candidate", (q) => q.eq("candidateId", c._id)).collect();
          if (pos.length) legs = pos.map((p) => ({ symbol: p.symbol.split("/")[0], long: Math.abs(p.weight) > 1e-6 }));
        }
        sleeves.push({
          id: c._id, name: c.name, source: c.source, family: isFlagship ? "CORE-4 portfolio" : fam(c.source), forwardSeed: m.forwardPaper === 1 || m.forwardPaperSeed === 1,
          userStrategy: m.userStrategy === 1 || c.source === "regime", flagship: isFlagship, legs,
          lastTs: snaps.length ? snaps[snaps.length - 1]._creationTime : undefined,
          leverage: m.leverage ?? (m.aggressive ? 1.5 : undefined),
          startEq: 10000, equity: acct.equity, peak: acct.peakEquity ?? peak,
          days: (Date.now() - startedAt) / 86400_000, ret: (acct.equity / (10000)) - 1,
          sharpe, maxDD, halted: !!acct.halted, bars: rets.length,
          spark: eqs.slice(-60),
          // the seeded BACKTEST headline (e.g. Daniel's +183% vs BTC +41%) so the
          // live card can show "backtest +X% / live so far Y%" — the distinction.
          backtestTotal: m.fullTotal,
          backtestHodlTotal: m.hodlTotal,
          // backtest vs-HODL stats (trend-beta sleeves carry these) — the "safer than HODL" story
          vsHodl: m.hodlMaxDD !== undefined ? { trendCagr: m.trendCagr ?? 0, trendMaxDD: m.trendMaxDD ?? 0, trendCalmar: m.trendCalmar ?? 0, hodlCagr: m.hodlCagr ?? 0, hodlMaxDD: m.hodlMaxDD ?? 0, hodlCalmar: m.hodlCalmar ?? 0 } : undefined,
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
      book: { t: bookT, eq: bookEq, sharpe: bookSharpe, ret: bookEq.length ? bookEq[bookEq.length - 1] - 1 : 0, maxDD: bookDD, bars: bookRets.length, lastTs: sleeves.reduce((mx, s) => Math.max(mx, s.lastTs ?? 0), 0) },
      sleeves,
    };
  },
});

/**
 * BENCHMARKS — the raw SPX + BTC buy-and-hold reference price series ({t,c}) so
 * EVERY chart on the dashboard can overlay them (rebased to each chart's window,
 * client-side). Read-only: just returns the two persisted benchmark configs. One
 * query feeds all charts (cached by Convex reactivity). NaN-guarded downstream.
 */
export const benchmarks = query({
  args: {},
  handler: async (ctx) => {
    const spx = await ctx.db.query("config").withIndex("by_key", (q) => q.eq("key", "benchmark_spx")).first();
    const btc = await ctx.db.query("config").withIndex("by_key", (q) => q.eq("key", "benchmark_btc")).first();
    const parse = (s?: string) => { if (!s) return null; try { return JSON.parse(s) as { t: number[]; c: number[] }; } catch { return null; } };
    return { spx: parse(spx?.json), btc: parse(btc?.json) };
  },
});

/**
 * MY STRATEGIES — Daniel's validated strategies for the "My Strategies" tab. Reads
 * a single persisted config row (key "my_strategies") computed by the spike backtest
 * (since-2020 equity curves + metrics + per-strategy BTC HODL overlay + plain-English
 * descriptions). Read-only, additive — no engine/gauntlet involvement.
 */
export const myStrategies = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("config").withIndex("by_key", (q) => q.eq("key", "my_strategies")).first();
    if (!row) return null;
    try { return JSON.parse(row.json) as { generatedAt: number; strategies: unknown[] }; } catch { return null; }
  },
});

/**
 * USER STRATEGIES — Daniel's hand-built regime strategies (source "regime" /
 * userStrategy), returned EXPLICITLY regardless of composite rank so the SOL hero
 * is never buried below the by-composite cutoff. Read-only; returns full rows
 * (dsl/metrics/curves) for the Strategies-tab hero.
 */
export const userStrategies = query({
  args: {},
  handler: async (ctx) => {
    // regime sleeves live in incubating (forward-paper); scan that small set + a
    // recent window for any others. No look-ahead — read-only.
    const inc = await ctx.db.query("candidates").withIndex("by_stage", (q) => q.eq("stage", "incubating")).collect();
    const rows = inc.filter((r) => r.source === "regime" || (() => { try { return JSON.parse(r.metrics ?? "{}").userStrategy === 1; } catch { return false; } })());
    return rows.map((r) => ({ _id: r._id, name: r.name, stage: r.stage, source: r.source, composite: r.composite, failedStage: r.failedStage, metrics: r.metrics, curves: r.curves }));
  },
});

/**
 * TREND vs HODL drawdown comparison — the "safer than HODL" payoff. Returns the
 * best trend-beta sleeve's BACKTEST equity (its WF OOS curve) + an UNDERWATER
 * (drawdown) curve, alongside BTC HODL rebased over the SAME window + its
 * drawdown, so the dashboard can show "~half the drawdown" at a glance. Plus the
 * side-by-side CAGR/maxDD/Sharpe/Calmar stats from the persisted metrics.
 */
export const trendVsHodl = query({
  args: {},
  handler: async (ctx) => {
    // pick the strongest trend-beta sleeve (by composite/OOS Sharpe), any stage.
    const rows = await ctx.db.query("candidates").withIndex("by_composite").order("desc").take(60);
    const tb = rows.filter((r) => r.source === "trendbeta" && r.curves);
    if (!tb.length) return null;
    const isAgg = (r: typeof tb[number]) => { const mm = parseMetrics(r.metrics); return mm.aggressive === 1 || (mm.leverage ?? 1) > 1; };
    // primary = the strongest NON-aggressive (1x) sleeve (the recommended variant)
    const best = tb.find((r) => !isAgg(r)) ?? tb[0];
    // Use the FULL-SAMPLE curve (regime-complete window: 2022-02, incl. the 2022
    // crash AND the 2023-24 bull) + the SPOT-HODL curve over the SAME window — NOT
    // the WF-OOS window, which starts after the 2022 bottom and flatters HODL. This
    // is the honest comparison where the trend filter beats HODL on both metrics.
    let curve: { t: number[]; eq: number[] } | null = null;
    let hodl: { t: number[]; eq: number[] } | null = null;
    try {
      const cv = JSON.parse(best.curves!) as { full?: { t: number[]; eq: number[] }; hodlFull?: { t: number[]; eq: number[] }; wf?: { t: number[]; eq: number[] }; port?: { t: number[]; eq: number[] } };
      curve = cv.full ?? cv.wf ?? cv.port ?? null;
      hodl = cv.hodlFull ?? null;     // spot HODL over the same full window (precomputed)
    } catch { /* */ }
    if (!curve || !curve.t?.length) return null;
    const m = parseMetrics(best.metrics);
    // fallback: if no precomputed hodlFull, rebase benchmark_btc over the curve window
    if (!hodl) {
      const btcCfg = await ctx.db.query("config").withIndex("by_key", (q) => q.eq("key", "benchmark_btc")).first();
      if (btcCfg) {
        try {
          const b = JSON.parse(btcCfg.json) as { t: number[]; c: number[] };
          const t0 = curve.t[0], t1 = curve.t[curve.t.length - 1];
          const t: number[] = [], eq: number[] = []; let base = 0;
          for (let i = 0; i < Math.min(b.t.length, b.c.length); i++) {
            const ts = b.t[i], cl = b.c[i];
            if (ts < t0 || ts > t1 || !Number.isFinite(cl) || cl <= 0) continue;
            if (!base) base = cl; t.push(ts); eq.push(cl / base);
          }
          if (t.length > 2) hodl = { t, eq };
        } catch { /* */ }
      }
    }
    // underwater (drawdown) curves + consistent stats computed from the SAME-window
    // curve (so trend & spot-HODL are apples-to-apples over the identical period —
    // NOT a cherry-picked window). HODL here is SPOT buy-and-hold (benchmark_btc
    // price, no funding) rebased to the trend curve's exact window.
    const underwater = (eq: number[]) => { const out: number[] = []; let peak = -Infinity; for (const v of eq) { peak = Math.max(peak, v); out.push(peak > 0 ? v / peak - 1 : 0); } return out; };
    const statsOf = (c: { t: number[]; eq: number[] }) => {
      if (!c.eq.length) return { total: null, cagr: null, maxDD: null, calmar: null };
      const total = c.eq[c.eq.length - 1] - 1;
      const years = Math.max(0.01, (c.t[c.t.length - 1] - c.t[0]) / (365 * 86400_000));
      const cagr = c.eq[c.eq.length - 1] > 0 ? Math.pow(c.eq[c.eq.length - 1], 1 / years) - 1 : -1;
      let peak = -Infinity, maxDD = 0; for (const v of c.eq) { peak = Math.max(peak, v); const d = peak > 0 ? v / peak - 1 : 0; if (d < maxDD) maxDD = d; }
      return { total, cagr, maxDD, calmar: maxDD < 0 ? cagr / Math.abs(maxDD) : 0 };
    };
    const ts = statsOf(curve);
    const hs = hodl ? statsOf(hodl) : { total: null, cagr: null, maxDD: null, calmar: null };
    // AGGRESSIVE 1.5x variant of the SAME coin (for the 1.5x-vs-1x-vs-HODL panel)
    const bestSym = best.name.match(/tb_(\w+?)_/)?.[1];
    const aggRow = tb.find((r) => isAgg(r) && r.name.match(/tb_(\w+?)_/)?.[1] === bestSym);
    let agg: { total: number | null; maxDD: number | null; calmar: number | null; leverage: number } | null = null;
    if (aggRow) { const am = parseMetrics(aggRow.metrics); agg = { total: am.fullTotal ?? null, maxDD: am.fullMaxDD ?? null, calmar: am.fullCalmar ?? null, leverage: am.leverage ?? 1.5 }; }
    const windowYears = (curve.t[curve.t.length - 1] - curve.t[0]) / (365 * 86400_000);
    return {
      name: best.name, symbol: (best.name.match(/tb_(\w+?)_/)?.[1] ?? "btc").toUpperCase(),
      windowYears,
      windowStart: curve.t[0], windowEnd: curve.t[curve.t.length - 1],
      strat: { t: curve.t, eq: curve.eq, dd: underwater(curve.eq) },
      hodl: hodl ? { t: hodl.t, eq: hodl.eq, dd: underwater(hodl.eq) } : null,
      stats: {
        // computed from the SAME-window curves (consistent, honest)
        trendTotal: ts.total, trendCagr: ts.cagr, trendMaxDD: ts.maxDD, trendCalmar: ts.calmar,
        trendSharpe: m.wfPooledSharpe ?? m.portOosSharpe ?? null,
        hodlTotal: hs.total, hodlCagr: hs.cagr, hodlMaxDD: hs.maxDD, hodlCalmar: hs.calmar,
      },
      agg,
    };
  },
});
