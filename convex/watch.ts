// WATCH tab backend — the live cockpit for one paper-traded strategy.
//
// Everything the /watch page needs in reactive Convex queries: the strategy's
// running trades (with the signal remark parsed into plain English), its live
// equity curve, the performance metrics tracked SINCE the strategy went live
// (return / CAGR / win-rate / Sharpe / maxDD / time-in-market — all 0 at the
// start, growing with every trade), and the precomputed indicator track (daily
// candles + the indicators it trades on + the exact trigger lines) that the
// indicators Trigger task persists into `strategyIndicators`.
//
// Heavy R2 / on-chain compute is NOT here (a query can't do network IO); it lives
// in src/trigger/indicators.ts, which calls saveIndicators below.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const MS_DAY = 86_400_000;
const START_EQ = 10_000; // every paper account starts here

const FAMILY: Record<string, string> = {
  blend: "On-chain + trend blend",
  trendbeta: "Trend-beta",
  ivsleeve: "IV-timing (DVOL)",
  onchain: "On-chain valuation",
  xsection: "Cross-sectional",
  core4: "Core-4 portfolio",
  regime: "Regime",
  gp: "Evolved (GP)",
  llm: "Evolved (LLM)",
  seed: "Seed",
  mutation: "Evolved",
  crossover: "Evolved",
};

function symbolOf(dsl: string): string {
  try {
    const d = JSON.parse(dsl) as { symbol?: string; coins?: { symbol: string }[] };
    return d.symbol ?? d.coins?.[0]?.symbol ?? "BTC/USDT";
  } catch { return "BTC/USDT"; }
}

// ---- pure performance metrics, computed from the live equity curve + trades ----
// All are "since live start": 0 at the beginning, building up with every step/trade.

interface Snap { ts: number; equity: number; ret: number }
interface Trade { ts: number; weightFrom: number; weightTo: number; price: number }

function computeMetrics(snaps: Snap[], trades: Trade[], startedAt: number, now: number) {
  const daysLive = Math.max(0, (now - startedAt) / MS_DAY);
  const lastEq = snaps.length ? snaps[snaps.length - 1].equity : START_EQ;
  const totalReturn = lastEq / START_EQ - 1;

  // max drawdown over the live equity curve
  let peak = START_EQ, maxDD = 0;
  for (const s of snaps) { if (s.equity > peak) peak = s.equity; const dd = s.equity / peak - 1; if (dd < maxDD) maxDD = dd; }

  // Sharpe from per-step returns, annualized at hourly cadence (needs enough steps)
  let sharpe: number | null = null;
  if (snaps.length >= 48) {
    let s = 0, sq = 0; const n = snaps.length;
    for (const x of snaps) { s += x.ret; sq += x.ret * x.ret; }
    const mean = s / n, sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
    sharpe = sd > 1e-12 ? (mean / sd) * Math.sqrt(24 * 365) : 0;
  }

  // CAGR — only meaningful after a couple of weeks; annualizing days is misleading
  const cagr = daysLive >= 14 && lastEq > 0
    ? Math.pow(lastEq / START_EQ, 365 / daysLive) - 1
    : null;

  // win-rate + closed-trade count: walk trades, realize P&L on every reduction
  // against the volume-weighted average entry price.
  let wEntry = 0, avgEntry = 0, wins = 0, losses = 0;
  for (const t of trades) {
    if (t.weightTo > t.weightFrom + 1e-9) {
      // adding exposure -> blend into the average entry price
      const add = t.weightTo - t.weightFrom;
      avgEntry = wEntry > 0 ? (avgEntry * wEntry + t.price * add) / t.weightTo : t.price;
      wEntry = t.weightTo;
    } else if (t.weightTo < t.weightFrom - 1e-9 && avgEntry > 0) {
      // reducing exposure -> realize on the closed slice
      const pnl = (t.price / avgEntry - 1) * (t.weightFrom - t.weightTo);
      if (pnl >= 0) wins++; else losses++;
      wEntry = t.weightTo;
      if (wEntry <= 1e-9) avgEntry = 0;
    }
  }
  const closed = wins + losses;
  const winRate = closed > 0 ? wins / closed : null;

  // time-in-market: fraction of live time the strategy held exposure (>2%)
  let exposed = 0, w = 0, cursor = startedAt;
  for (const t of trades) {
    if (t.ts > cursor) { if (Math.abs(w) > 0.02) exposed += t.ts - cursor; cursor = t.ts; }
    w = t.weightTo;
  }
  if (now > cursor && Math.abs(w) > 0.02) exposed += now - cursor;
  const timeInMarket = now > startedAt ? exposed / (now - startedAt) : 0;

  return {
    totalReturn, cagr, maxDD, sharpe, winRate,
    trades: trades.length, closedTrades: closed, wins, losses,
    daysLive, timeInMarket, equity: lastEq, peakEquity: peak,
  };
}

/** Everything the Watch page renders for ONE strategy. Reactive. */
export const liveState = query({
  args: { candidateId: v.id("candidates"), now: v.optional(v.number()) },
  handler: async (ctx, { candidateId, now }) => {
    const cand = await ctx.db.get(candidateId);
    if (!cand) return null;
    const acct = await ctx.db.query("paperAccounts").withIndex("by_candidate", (q) => q.eq("candidateId", candidateId)).first();
    const positions = await ctx.db.query("paperPositions").withIndex("by_candidate", (q) => q.eq("candidateId", candidateId)).collect();
    const tradesDesc = await ctx.db.query("paperTrades").withIndex("by_candidate", (q) => q.eq("candidateId", candidateId)).order("desc").take(2000);
    const snapsDesc = await ctx.db.query("equitySnapshots").withIndex("by_candidate_ts", (q) => q.eq("candidateId", candidateId)).order("desc").take(6000);
    const indRow = await ctx.db.query("strategyIndicators").withIndex("by_candidate", (q) => q.eq("candidateId", candidateId)).first();

    const trades = tradesDesc.slice().reverse();   // ascending
    const snaps = snapsDesc.slice().reverse();      // ascending
    const startedAt = acct?.startedAt ?? cand.createdAt;
    const nowTs = now ?? (snaps.length ? snaps[snaps.length - 1].ts : startedAt);

    const metrics = computeMetrics(snaps, trades, startedAt, nowTs);

    // equity curve (growth of $1), downsampled to keep the payload light
    const STEP = Math.max(1, Math.ceil(snaps.length / 600));
    const eqT: number[] = [], eqV: number[] = [];
    for (let i = 0; i < snaps.length; i += STEP) { eqT.push(snaps[i].ts); eqV.push(snaps[i].equity / START_EQ); }
    if (snaps.length && (snaps.length - 1) % STEP !== 0) { const s = snaps[snaps.length - 1]; eqT.push(s.ts); eqV.push(s.equity / START_EQ); }

    const weight = positions[0]?.weight ?? 0;
    const indicators = indRow ? (() => { try { return JSON.parse(indRow.json); } catch { return null; } })() : null;

    return {
      meta: {
        candidateId, name: cand.name, source: cand.source,
        family: FAMILY[cand.source] ?? cand.source,
        symbol: symbolOf(cand.dsl),
        startedAt, daysLive: metrics.daysLive,
        halted: acct?.halted ?? false,
        equity: metrics.equity, currentWeight: weight,
        position: Math.abs(weight) > 0.02 ? (weight > 0 ? "LONG" : "SHORT") : "CASH",
        hasAccount: !!acct,
        indicatorsAsOf: indRow?.updatedAt ?? null,
        logic: indicators?.logic ?? null,
      },
      metrics,
      equity: { t: eqT, eq: eqV },
      // most-recent-first trades for the log, with the parsed remark
      trades: tradesDesc.slice(0, 200).map((t) => ({
        _id: t._id, ts: t.ts, weightFrom: t.weightFrom, weightTo: t.weightTo,
        price: t.price, costUsd: t.costUsd, note: t.note ?? null,
        reason: humanizeNote(t.note, t.weightTo > t.weightFrom),
      })),
      indicators,
    };
  },
});

/** The list of watchable strategies for the picker (anything with a paper account). */
export const liveStrategies = query({
  args: {},
  handler: async (ctx) => {
    const accts = await ctx.db.query("paperAccounts").collect();
    const out: {
      id: Id<"candidates">; name: string; source: string; family: string;
      symbol: string; startedAt: number; equity: number; halted: boolean; primary: boolean;
    }[] = [];
    for (const a of accts) {
      const c = await ctx.db.get(a.candidateId);
      if (!c) continue;
      const symbol = symbolOf(c.dsl);
      out.push({
        id: a.candidateId, name: c.name, source: c.source,
        family: FAMILY[c.source] ?? c.source, symbol,
        startedAt: a.startedAt, equity: a.equity, halted: a.halted,
        primary: c.source === "blend" && symbol === "BTC/USDT",
      });
    }
    // the 70/30 BTC blend (Daniel's best strat) first, then other blends, then the rest
    const rank = (s: { source: string; primary: boolean }) => (s.primary ? 0 : s.source === "blend" ? 1 : 2);
    out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return out;
  },
});

/** Upsert the precomputed indicator track for a candidate (called by the Trigger task). */
export const saveIndicators = mutation({
  args: { candidateId: v.id("candidates"), json: v.string() },
  handler: async (ctx, { candidateId, json }) => {
    const existing = await ctx.db.query("strategyIndicators").withIndex("by_candidate", (q) => q.eq("candidateId", candidateId)).first();
    if (existing) await ctx.db.patch(existing._id, { json, updatedAt: Date.now() });
    else await ctx.db.insert("strategyIndicators", { candidateId, json, updatedAt: Date.now() });
    return { ok: true };
  },
});

/** Turn a stored trade note into a short plain-English reason for the trade log. */
function humanizeNote(note: string | undefined, isBuy: boolean): string {
  if (!note) return isBuy ? "signal: add exposure" : "signal: reduce exposure";
  if (note.startsWith("blend:")) {
    const a = note.match(/legA([\d.]+)/)?.[1];
    const b = note.match(/legB([\d.]+)/)?.[1];
    const side = isBuy ? "Accumulate" : "Distribute";
    return `${side} — on-chain leg ${a ?? "?"}, trend leg ${b ?? "?"}`;
  }
  if (note.startsWith("trend:")) {
    const win = note.match(/sma(\d+)/)?.[1];
    return isBuy ? `Trend up — reclaimed SMA ${win}` : `Trend down — lost SMA ${win}`;
  }
  if (note.startsWith("iv:")) return `IV regime: ${note.slice(3)}`;
  if (note.startsWith("core4:")) return `Core-4 rebalance (${note.slice(6)})`;
  if (note.startsWith("LIQUIDATED")) return `⚠️ Liquidated (${note.replace("LIQUIDATED ", "")})`;
  return note;
}
