// Live paper trading: hourly step for every incubating strategy + the champion.
// Pure simulation with realistic fills (slippage + fees + funding), designed so
// the fill function swaps for a real exchange connector (testnet, then live)
// without touching the accounting.

import { logger, schedules } from "@trigger.dev/sdk/v3";
import { api, convex } from "../lib/convexClient";
import { mergeConfig } from "../lib/appConfig";
import { loadBars } from "../lib/data";
import { computeSignals, toArrays } from "../engine/compile";
import { DEFAULT_FEE_BPS, PPY, SLIP_BPS, type Bars, type StrategyDoc } from "../engine/types";
import { sendTelegram } from "../lib/telegram";
import type { Id } from "../../convex/_generated/dataModel";

const EWMA_LAMBDA = 0.94;

/** Compute the strategy's target weight for a symbol from the latest CLOSED bar. */
function targetWeight(doc: StrategyDoc, params: Record<string, number>, bars: Bars, prevDir: number): { dir: number; weight: number; lastClose: number; lastTs: number } {
  // use the trailing 3000 bars for warm indicators
  const n = bars.t.length;
  const from = Math.max(0, n - 3000);
  const slice: Bars = {
    symbol: bars.symbol, tf: bars.tf,
    t: bars.t.slice(from), o: bars.o.slice(from), h: bars.h.slice(from),
    l: bars.l.slice(from), c: bars.c.slice(from), v: bars.v.slice(from),
  };
  const inp = toArrays(slice);
  const sig = computeSignals(doc, inp, params);
  const i = slice.t.length - 1;
  let dir = prevDir;
  if (dir === 1 && sig.longExit[i]) dir = 0;
  else if (dir === -1 && sig.shortExit && sig.shortExit[i]) dir = 0;
  if (dir === 0) {
    if (sig.longEntry[i]) dir = 1;
    else if (sig.shortEntry && sig.shortEntry[i]) dir = -1;
  }
  // vol targeting from EWMA of close returns
  let ewmaVar = 0; let init = false;
  for (let k = Math.max(1, i - 500); k <= i; k++) {
    const r = inp.c[k] / inp.c[k - 1] - 1;
    if (!init) { ewmaVar = r * r; init = true; } else ewmaVar = EWMA_LAMBDA * ewmaVar + (1 - EWMA_LAMBDA) * r * r;
  }
  const ppy = PPY[bars.tf] ?? 8760;
  const perBarTargetVar = (doc.risk.volTargetAnnual ** 2) / ppy;
  const scale = ewmaVar > 1e-12 ? Math.sqrt(perBarTargetVar / ewmaVar) : 1;
  const weight = dir * Math.min(doc.risk.maxLeverage, Math.max(0, scale));
  return { dir, weight, lastClose: inp.c[i], lastTs: slice.t[i] };
}

export const paperStep = schedules.task({
  id: "paper-step",
  cron: "12 * * * *",
  machine: { preset: "small-2x" },
  maxDuration: 1500,
  run: async () => {
    const cx = convex();
    const cfg = mergeConfig(await cx.query(api.pipeline.getConfig, { key: "app" }));
    const incubating = await cx.query(api.candidates.listByStage, { stage: "incubating" });
    const eligible = await cx.query(api.candidates.listByStage, { stage: "eligible" });
    const champion = await cx.query(api.candidates.champion, {});
    const actives = [...incubating, ...eligible, ...(champion ? [champion] : [])];
    if (!actives.length) { logger.log("no active paper strategies"); return { stepped: 0 }; }

    // load universe bars once
    const universeBars = new Map<string, Bars>();
    for (const sym of cfg.universe) {
      const b = await loadBars(sym, cfg.tf);
      if (b) universeBars.set(sym, b);
    }
    const nSym = universeBars.size || 1;
    const costRate = (sym: string) => (DEFAULT_FEE_BPS + (SLIP_BPS[sym] ?? 4)) / 10_000;

    let stepped = 0;
    for (const cand of actives) {
      try {
        const candidateId = cand._id as Id<"candidates">;
        const acct = await cx.query(api.paper.getAccount, { candidateId });
        if (!acct || acct.halted) continue;
        const doc = JSON.parse(cand.dsl) as StrategyDoc;
        const params = cand.bestParams ? JSON.parse(cand.bestParams) as Record<string, number> : {};
        const positions = await cx.query(api.paper.positionsFor, { candidateId });
        const posBySym = new Map(positions.map((p) => [p.symbol, p]));

        let stepTs = 0;
        let portRet = 0;
        let costUsd = 0;
        const newPositions: { symbol: string; weight: number; entryPrice?: number }[] = [];
        const trades: { symbol: string; ts: number; weightFrom: number; weightTo: number; price: number; fillPrice: number; costUsd: number; note?: string }[] = [];

        for (const [sym, bars] of universeBars) {
          const cur = posBySym.get(sym);
          const prevWeight = cur?.weight ?? 0;
          const prevPrice = cur?.entryPrice ?? 0;
          const prevDir = Math.sign(prevWeight);
          const t = targetWeight(doc, params, bars, prevDir);
          stepTs = Math.max(stepTs, t.lastTs);

          // mark-to-market on the bar we just closed
          if (prevWeight !== 0 && prevPrice > 0) {
            portRet += (prevWeight / nSym) * (t.lastClose / prevPrice - 1);
          }
          // funding accrued since last step
          if (bars.fundingT && bars.fundingR && acct.lastStepTs) {
            for (let fi = bars.fundingT.length - 1; fi >= 0; fi--) {
              const ft = bars.fundingT[fi];
              if (ft <= acct.lastStepTs) break;
              if (ft <= Date.now()) portRet -= (prevWeight / nSym) * bars.fundingR[fi];
            }
          }
          // rebalance to target with simulated fill
          const wTo = t.weight;
          if (Math.abs(wTo - prevWeight) > 0.02) {
            const slip = (SLIP_BPS[sym] ?? 4) / 10_000;
            const side = Math.sign(wTo - prevWeight);
            const fillPrice = t.lastClose * (1 + side * slip);
            const tradeCost = Math.abs(wTo - prevWeight) / nSym * costRate(sym);
            portRet -= tradeCost;
            costUsd += tradeCost * acct.equity;
            trades.push({ symbol: sym, ts: t.lastTs, weightFrom: prevWeight, weightTo: wTo, price: t.lastClose, fillPrice, costUsd: tradeCost * acct.equity });
          }
          newPositions.push({ symbol: sym, weight: Math.abs(wTo - prevWeight) > 0.02 ? wTo : prevWeight, entryPrice: t.lastClose });
        }

        if (stepTs === 0) continue;
        const newEquity = acct.equity * (1 + portRet);

        // ---- kill-switch ----
        const daySnaps = await cx.query(api.paper.snapshots, { candidateId, sinceTs: stepTs - 86400_000 });
        const weekSnaps = await cx.query(api.paper.snapshots, { candidateId, sinceTs: stepTs - 7 * 86400_000 });
        const monthSnaps = await cx.query(api.paper.snapshots, { candidateId, sinceTs: stepTs - 30 * 86400_000 });
        const ddFrom = (snaps: { equity: number }[]) => {
          if (!snaps.length) return 0;
          const maxEq = Math.max(...snaps.map((s) => s.equity), newEquity);
          return newEquity / maxEq - 1;
        };
        let halted = false, haltReason: string | undefined;
        if (ddFrom(daySnaps) < cfg.killSwitch.dailyDD) { halted = true; haltReason = `daily DD ${(ddFrom(daySnaps) * 100).toFixed(1)}%`; }
        else if (ddFrom(weekSnaps) < cfg.killSwitch.weeklyDD) { halted = true; haltReason = `weekly DD ${(ddFrom(weekSnaps) * 100).toFixed(1)}%`; }
        else if (ddFrom(monthSnaps) < cfg.killSwitch.monthlyDD) { halted = true; haltReason = `monthly DD ${(ddFrom(monthSnaps) * 100).toFixed(1)}%`; }

        await cx.mutation(api.paper.applyStep, {
          candidateId, ts: stepTs, equity: newEquity, ret: portRet,
          halted: halted || undefined, haltReason,
          positions: halted ? newPositions.map((p) => ({ ...p, weight: 0 })) : newPositions,
          trades,
        });
        stepped++;

        if (halted) {
          await sendTelegram(`🛑 *finance-engine-v2 kill-switch*\n"${cand.name}" (${cand.stage}) halted: ${haltReason}\nEquity: $${newEquity.toFixed(0)}`);
          await cx.mutation(api.pipeline.addLesson, {
            source: cand.source, candidateId,
            text: `KILL-SWITCH in paper: "${cand.name}" halted (${haltReason}) after passing the full gauntlet. Live regime differs from validation.`,
          });
          if (cand.stage === "champion") {
            await cx.mutation(api.promotions.demoteChampion, { reason: `kill-switch: ${haltReason}` });
            await sendTelegram(`⚠️ Champion demoted + rolled back to previous champion.`);
          }
        }
      } catch (err) {
        logger.error(`paper step failed for ${cand.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
    logger.log(`paper step: ${stepped}/${actives.length} strategies updated`);
    return { stepped };
  },
});
