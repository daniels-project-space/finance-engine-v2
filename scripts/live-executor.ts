// LIVE EXECUTOR — the bridge from a validated strategy to real orders.
//
//   npx tsx scripts/live-executor.ts            # process all dryrun+live deployments
//   npx tsx scripts/live-executor.ts --once <depId>   # single deployment
//
// Runs from the EU VPS on an hourly cron (Binance geo-blocks US cloud). Convex
// `liveDeployments` is the source of truth for state; the exchange for fills.
//
// Safety model (in order):
//   1. mode gate      — only "dryrun"/"live" rows are processed; dryrun never sends.
//   2. staleness gate — no trade unless the strategy bar is fresh (targets.ts).
//   3. one-trade-per-bar — a strategy bar is consumed at most once (lastTargetTs
//      + a pre-flight "sent" intent row that survives a crash mid-order).
//   4. kill switches  — daily-loss and peak-drawdown breaches flatten + halt.
//   5. clamps         — weight<=maxWeight, BUY<=deployment cash AND account free
//      USDT, SELL<=tracked base qty AND account free base. Withdrawals: never.
//
// Dry-run mode exercises this exact code path (fills simulated at ticker price
// with taker fee + slip) so flipping to live changes only who fills the order.

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { ensureEnv } from "../src/live/env";
import { isLiveTradingExplicitlyApproved, LIVE_TRADING_APPROVAL_REASON } from "../src/live/approval";
import { computeLiveTarget } from "../src/live/targets";
import {
  baseAsset, getBalances, getFilters, getPrice, getRestrictions, marketOrder, roundToStep,
  type SymbolFilters,
} from "../src/live/binance";
import { sendTelegram } from "../src/lib/telegram";

const TAKER_FEE = 0.001;                                   // 10 bps spot taker
const SLIP_BPS: Record<string, number> = { "BTC/USDT": 1.5, "ETH/USDT": 2, "SOL/USDT": 3 };

type Dep = {
  _id: Id<"liveDeployments">; candidateId: Id<"candidates">; name: string; symbol: string;
  mode: string; capitalUsd: number; maxWeight: number; rebalanceBand: number;
  maxDailyLossPct: number; maxDrawdownPct: number;
  cashUsd: number; baseQty: number; curWeight: number; equityUsd: number; peakEquityUsd: number;
  dayKey?: string; dayStartEquityUsd?: number; lastRunTs?: number; lastTargetTs?: number;
};

const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

async function main() {
  await ensureEnv(["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "BINANCE_API_KEY", "BINANCE_API_SECRET"]);
  const url = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL missing");
  const cx = new ConvexHttpClient(url);

  const onlyId = process.argv.includes("--once") ? process.argv[process.argv.indexOf("--once") + 1] : undefined;
  let deps = (await cx.query(api.live.listActive, {})) as Dep[];
  if (onlyId) deps = deps.filter((d) => (d._id as string) === onlyId);
  if (!deps.length) { console.log("no active deployments"); return; }

  // live-mode capability check once per run (read-only key => live orders refuse)
  let canTradeLive = false;
  try { canTradeLive = (await getRestrictions()).enableSpotAndMarginTrading; } catch (e) {
    console.warn("restrictions check failed:", e instanceof Error ? e.message : e);
  }

  for (const dep of deps) {
    try {
      await processDeployment(cx, dep, canTradeLive);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[${dep.name}] executor error: ${msg}`);
      await sendTelegram(`🔴 *live-executor* error on "${dep.name}": ${msg.slice(0, 300)}`);
    }
  }
}

async function processDeployment(cx: ConvexHttpClient, dep: Dep, canTradeLive: boolean) {
  const now = Date.now();
  const tag = `[${dep.name}|${dep.mode}]`;

  // ---- 1. today's target from the exact engine signal path ----
  const cand = await cx.query(api.candidates.get, { id: dep.candidateId });
  if (!cand) throw new Error("candidate row missing");
  const res = await computeLiveTarget(cand.dsl, cand.bestParams ?? undefined);
  if (!res.ok) {
    console.log(`${tag} skip: ${res.error}`);
    // alert once per UTC day, not hourly
    if (dep.dayKey !== utcDay(now)) await sendTelegram(`⚠️ *live-executor* "${dep.name}" skipped: ${res.error}`);
    return;
  }
  const target = res.target;

  // ---- 2. mark-to-market ----
  let price = target.lastClose;
  try { price = await getPrice(dep.symbol); } catch { /* fall back to last close */ }
  let cash = dep.cashUsd, base = dep.baseQty;
  const equity = cash + base * price;
  const dayKey = utcDay(now);
  const dayStart = dep.dayKey === dayKey ? (dep.dayStartEquityUsd ?? equity) : equity;
  const curWeight = equity > 0 ? (base * price) / equity : 0;

  const record = async (extra?: { lastTargetTs?: number; halt?: boolean; haltReason?: string; cash?: number; base?: number }) => {
    const c = extra?.cash ?? cash, b = extra?.base ?? base;
    const eq = c + b * price;
    await cx.mutation(api.live.recordRun, {
      id: dep._id, ts: now, cashUsd: c, baseQty: b,
      curWeight: eq > 0 ? (b * price) / eq : 0, equityUsd: eq, price,
      dayKey, dayStartEquityUsd: dayStart,
      ...(extra?.lastTargetTs !== undefined ? { lastTargetTs: extra.lastTargetTs } : {}),
      ...(extra?.halt ? { halt: true, haltReason: extra.haltReason } : {}),
    });
  };

  // ---- 3. kill switches (every run, before anything else can trade) ----
  const ddPct = dep.peakEquityUsd > 0 ? (equity / Math.max(dep.peakEquityUsd, equity) - 1) * 100 : 0;
  const dayLossPct = dayStart > 0 ? (equity / dayStart - 1) * 100 : 0;
  const breach =
    ddPct <= -dep.maxDrawdownPct ? `max drawdown ${ddPct.toFixed(1)}% <= -${dep.maxDrawdownPct}%`
    : dayLossPct <= -dep.maxDailyLossPct ? `daily loss ${dayLossPct.toFixed(1)}% <= -${dep.maxDailyLossPct}%`
    : null;
  if (breach) {
    let note = `KILL-SWITCH: ${breach} — flattening`;
    if (base > 1e-12) {
      const flat = await executeOrder(cx, dep, {
        side: "SELL", targetWeight: 0, fromWeight: curWeight, barTs: now, price,
        desiredNotional: base * price, cash, base, canTradeLive, note,
      });
      cash = flat.cash; base = flat.base;
    }
    await record({ halt: true, haltReason: breach, cash, base });
    await sendTelegram(`🛑 *live-executor* HALTED "${dep.name}" (${dep.mode}): ${note}`);
    console.log(`${tag} ${note}`);
    return;
  }

  // ---- 4. one decision per strategy bar ----
  if (dep.lastTargetTs === target.lastTs) {
    await record();                     // hourly equity mark, no trade
    console.log(`${tag} bar already consumed (${new Date(target.lastTs).toISOString().slice(0, 10)}), eq $${equity.toFixed(2)}`);
    return;
  }
  // crash guard: if an intent/fill row for this bar already exists, don't re-trade
  const recent = await cx.query(api.live.ordersFor, { deploymentId: dep._id, limit: 10 });
  if (recent.some((o: { ts: number; status: string }) => o.ts === target.lastTs && ["sent", "filled", "simulated"].includes(o.status))) {
    await record({ lastTargetTs: target.lastTs });
    await sendTelegram(`⚠️ *live-executor* "${dep.name}": found existing order for bar ${new Date(target.lastTs).toISOString()} — marked consumed, verify fills manually`);
    return;
  }

  const targetW = Math.min(target.weight, dep.maxWeight);
  const delta = targetW - curWeight;
  if (Math.abs(delta) < dep.rebalanceBand) {
    await record({ lastTargetTs: target.lastTs });
    console.log(`${tag} within band: cur ${curWeight.toFixed(3)} vs target ${targetW.toFixed(3)} (${target.note}), eq $${equity.toFixed(2)}`);
    return;
  }

  // ---- 5. size + execute ----
  const out = await executeOrder(cx, dep, {
    side: delta > 0 ? "BUY" : "SELL",
    targetWeight: targetW, fromWeight: curWeight, barTs: target.lastTs, price,
    desiredNotional: Math.abs(delta) * equity, cash, base, canTradeLive,
    note: target.note,
  });
  cash = out.cash; base = out.base;
  await record({ lastTargetTs: target.lastTs, cash, base });
  if (out.executed) {
    const eq = cash + base * price;
    await sendTelegram(
      `${dep.mode === "live" ? "🟢 LIVE" : "🧪 DRY-RUN"} *${dep.name}*: ${delta > 0 ? "BUY" : "SELL"} $${out.filledNotional.toFixed(2)} ${dep.symbol} @ ~$${out.fillPrice.toFixed(2)}\n` +
      `weight ${curWeight.toFixed(2)} → ${targetW.toFixed(2)} (${target.note})\nequity $${eq.toFixed(2)}`);
  }
  console.log(`${tag} ${out.summary}`);
}

async function executeOrder(cx: ConvexHttpClient, dep: Dep, a: {
  side: "BUY" | "SELL"; targetWeight: number; fromWeight: number; barTs: number; price: number;
  desiredNotional: number; cash: number; base: number; canTradeLive: boolean; note: string;
}): Promise<{ cash: number; base: number; executed: boolean; filledNotional: number; fillPrice: number; summary: string }> {
  let { cash, base } = a;
  const slip = (SLIP_BPS[dep.symbol] ?? 3) / 1e4;
  const noop = (summary: string, status = "skipped", note = summary) =>
    cx.mutation(api.live.recordOrder, {
      deploymentId: dep._id, ts: a.barTs, mode: dep.mode, symbol: dep.symbol, side: a.side,
      qty: 0, notionalUsd: 0, price: a.price, status, targetWeight: a.targetWeight, fromWeight: a.fromWeight, note,
    }).then(() => ({ cash, base, executed: false, filledNotional: 0, fillPrice: a.price, summary }));

  let filters: SymbolFilters;
  try { filters = await getFilters(dep.symbol); } catch { filters = { stepSize: 1e-5, minQty: 0, minNotional: 10 }; }

  // clamp the notional to what this deployment actually owns
  let notional = a.desiredNotional;
  if (a.side === "BUY") notional = Math.min(notional, cash * 0.998);
  else notional = Math.min(notional, base * a.price);
  // full exits: sell everything rather than leaving dust below the band
  if (a.side === "SELL" && a.targetWeight <= dep.rebalanceBand) notional = base * a.price;

  if (notional < Math.max(filters.minNotional, 10) * 1.02) {
    return noop(`below min notional ($${notional.toFixed(2)}) — skipped`);
  }

  if (dep.mode === "live") {
    // A `live` database row alone must never authorize a real order. This
    // second, process-scoped gate is deliberately separate from Convex and
    // defaults closed when the VPS is restarted or its environment changes.
    if (!isLiveTradingExplicitlyApproved()) {
      return noop(`live order blocked: ${LIVE_TRADING_APPROVAL_REASON}`, "rejected", LIVE_TRADING_APPROVAL_REASON);
    }
    if (!a.canTradeLive) {
      await sendTelegram(`🔒 *live-executor* "${dep.name}" wants to ${a.side} $${notional.toFixed(2)} but the Binance key is READ-ONLY. Enable Spot & Margin Trading (or swap the key) to let it trade.`);
      return noop(`live order blocked: key read-only`, "rejected", "binance key lacks Spot trading permission");
    }
    // shared-account guard: never spend/sell more than the account actually has free
    try {
      const bal = await getBalances();
      if (a.side === "BUY") notional = Math.min(notional, (bal.USDT ?? 0) * 0.98);
      else notional = Math.min(notional, (bal[baseAsset(dep.symbol)] ?? 0) * a.price);
      if (notional < Math.max(filters.minNotional, 10)) return noop("account balance below min notional — skipped");
    } catch (e) {
      return noop(`balance check failed: ${e instanceof Error ? e.message.slice(0, 120) : e}`, "error");
    }

    // pre-flight intent row: if we crash mid-order the next run sees it and stops
    const intentId = await cx.mutation(api.live.recordOrder, {
      deploymentId: dep._id, ts: a.barTs, mode: "live", symbol: dep.symbol, side: a.side,
      qty: 0, notionalUsd: notional, price: a.price, status: "sent",
      targetWeight: a.targetWeight, fromWeight: a.fromWeight, note: a.note,
    });
    try {
      const clientId = `fev2-${(dep._id as string).slice(-6)}-${Math.floor(a.barTs / 1000)}`;
      const order = a.side === "BUY"
        ? await marketOrder({ symbol: dep.symbol, side: "BUY", quoteOrderQty: notional, clientId })
        : await marketOrder({ symbol: dep.symbol, side: "SELL", quantity: roundToStep(notional / a.price, filters.stepSize), clientId });
      // commissions: base-asset commission reduces qty received; quote commission reduces cash
      let qtyNet = order.executedQty, quoteNet = order.quoteSpent;
      for (const f of order.fills) {
        if (f.commissionAsset === baseAsset(dep.symbol)) qtyNet -= f.commission;
        else if (f.commissionAsset === "USDT") quoteNet += a.side === "BUY" ? f.commission : -f.commission;
      }
      if (a.side === "BUY") { base += qtyNet; cash -= quoteNet; }
      else { base -= order.executedQty; cash += quoteNet; }
      await cx.mutation(api.live.patchOrder, {
        id: intentId as Id<"liveOrders">, status: "filled", qty: order.executedQty,
        notionalUsd: order.quoteSpent, fillPrice: order.avgPrice, exchangeOrderId: order.orderId,
      });
      return { cash, base, executed: true, filledNotional: order.quoteSpent, fillPrice: order.avgPrice, summary: `LIVE ${a.side} $${order.quoteSpent.toFixed(2)} @ ${order.avgPrice.toFixed(2)}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 250) : String(e);
      await cx.mutation(api.live.patchOrder, { id: intentId as Id<"liveOrders">, status: "error", note: msg });
      await sendTelegram(`🔴 *live-executor* "${dep.name}" ${a.side} FAILED: ${msg}`);
      return { cash, base, executed: false, filledNotional: 0, fillPrice: a.price, summary: `LIVE ${a.side} failed: ${msg}` };
    }
  }

  // ---- dryrun: simulate the fill the live path would have gotten ----
  const fillPrice = a.price * (1 + (a.side === "BUY" ? slip : -slip));
  const qty = a.side === "BUY" ? notional / fillPrice : roundToStep(Math.min(notional / a.price, base), filters.stepSize);
  if (a.side === "BUY") { base += qty * (1 - TAKER_FEE); cash -= notional; }
  else { base -= qty; cash += qty * fillPrice * (1 - TAKER_FEE); }
  await cx.mutation(api.live.recordOrder, {
    deploymentId: dep._id, ts: a.barTs, mode: "dryrun", symbol: dep.symbol, side: a.side,
    qty, notionalUsd: a.side === "BUY" ? notional : qty * fillPrice, price: a.price, fillPrice,
    status: "simulated", targetWeight: a.targetWeight, fromWeight: a.fromWeight, note: a.note,
  });
  return { cash, base, executed: true, filledNotional: a.side === "BUY" ? notional : qty * fillPrice, fillPrice, summary: `DRYRUN ${a.side} $${notional.toFixed(2)} @ ~${fillPrice.toFixed(2)}` };
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
