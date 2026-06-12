// Daily monitor: graduate incubated strategies, auto-promote validated ones,
// demote degrading champions. The "never replaces until validated" protocol.

import { logger, schedules } from "@trigger.dev/sdk";
import { api, convex } from "../lib/convexClient";
import { mergeConfig } from "../lib/appConfig";
import { sendTelegram } from "../lib/telegram";
import type { Id } from "../../convex/_generated/dataModel";

function liveSharpe(snaps: { ret: number }[], periodsPerYear = 8760): number {
  if (snaps.length < 48) return 0;
  const rets = snaps.map((s) => s.ret);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(Math.max(0, rets.reduce((a, b) => a + b * b, 0) / rets.length - mean * mean));
  return sd > 1e-12 ? (mean / sd) * Math.sqrt(periodsPerYear) : 0;
}

export const dailyMonitor = schedules.task({
  id: "daily-monitor",
  cron: "0 7 * * *",
  machine: "small-1x",
  maxDuration: 900,
  run: async () => {
    const cx = convex();
    const runId = await cx.mutation(api.pipeline.startRun, { kind: "monitor" });
    const events: string[] = [];
    try {
      const cfg = mergeConfig(await cx.query(api.pipeline.getConfig, { key: "app" }));
      const now = Date.now();
      const champion = await cx.query(api.candidates.champion, {});

      // ---- 1. incubation graduation ----
      const incubating = await cx.query(api.candidates.listByStage, { stage: "incubating" });
      for (const cand of incubating) {
        const candidateId = cand._id as Id<"candidates">;
        const acct = await cx.query(api.paper.getAccount, { candidateId });
        if (!acct) continue;
        if (acct.halted) {
          await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: "S7-paper", failedReason: acct.haltReason ?? "kill-switch" });
          events.push(`☠️ "${cand.name}" failed paper incubation (${acct.haltReason})`);
          continue;
        }
        const days = (now - (cand.incubationStartedAt ?? acct.startedAt)) / 86400_000;
        if (days < cfg.floors.incubationDays) continue;

        const snaps = await cx.query(api.paper.snapshots, { candidateId, sinceTs: cand.incubationStartedAt });
        const live = liveSharpe(snaps as { ret: number }[]);
        const metrics = cand.metrics ? JSON.parse(cand.metrics) as { bootstrapP5?: number } : {};
        const band = (metrics.bootstrapP5 ?? 0) - 0.5; // tolerance: live can run half a Sharpe below the backtest 5th pct
        if (live >= band) {
          await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "eligible" });
          events.push(`🎓 "${cand.name}" graduated incubation (${days.toFixed(0)}d, live sharpe ${live.toFixed(2)} vs band ${band.toFixed(2)})`);
        } else {
          await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: "S7-paper", failedReason: `live sharpe ${live.toFixed(2)} below band ${band.toFixed(2)}` });
          await cx.mutation(api.pipeline.addLesson, {
            source: cand.source, candidateId,
            text: `INCUBATION-FAIL: "${cand.name}" live sharpe ${live.toFixed(2)} fell below its backtest confidence band — backtest optimistic for this family.`,
          });
          events.push(`📉 "${cand.name}" failed incubation (live ${live.toFixed(2)} < band ${band.toFixed(2)})`);
        }
      }

      // ---- 2. auto-promotion ----
      if (cfg.autoPromote) {
        const eligibleAll = await cx.query(api.candidates.listByStage, { stage: "eligible" });
        const best = eligibleAll.filter((c) => c.composite !== undefined).sort((a, b) => (b.composite ?? 0) - (a.composite ?? 0))[0];
        if (best) {
          const champComposite = champion?.composite ?? 0;
          if (!champion || (best.composite ?? 0) >= champComposite * cfg.floors.championBeatRatio) {
            await cx.mutation(api.promotions.promote, { candidateId: best._id as Id<"candidates">, approvedBy: "auto", note: `composite ${(best.composite ?? 0).toFixed(2)} vs champion ${champComposite.toFixed(2)}` });
            events.push(`👑 PROMOTED "${best.name}" to champion (composite ${(best.composite ?? 0).toFixed(2)}${champion ? `, replacing "${champion.name}" — archived, rollback available` : ""})`);
          }
        }
      }

      // ---- 3. champion degradation ----
      if (champion) {
        const candidateId = champion._id as Id<"candidates">;
        const acct = await cx.query(api.paper.getAccount, { candidateId });
        const snaps = await cx.query(api.paper.snapshots, { candidateId, sinceTs: now - 30 * 86400_000 });
        if (acct && !acct.halted && (snaps as unknown[]).length > 24 * 14) {
          const live = liveSharpe(snaps as { ret: number }[]);
          const metrics = champion.metrics ? JSON.parse(champion.metrics) as { bootstrapP5?: number } : {};
          const band = (metrics.bootstrapP5 ?? 0) - 1.0; // champions get a wider band before demotion
          if (live < band) {
            await cx.mutation(api.promotions.demoteChampion, { reason: `30d live sharpe ${live.toFixed(2)} < degradation band ${band.toFixed(2)}` });
            events.push(`⚠️ Champion "${champion.name}" demoted (live ${live.toFixed(2)} < ${band.toFixed(2)}), rolled back`);
          }
        }
      }

      await cx.mutation(api.pipeline.finishRun, { id: runId, status: "ok", summary: JSON.stringify(events) });
      if (events.length) await sendTelegram(`*finance-engine-v2 daily monitor*\n${events.join("\n")}`);
      logger.log(events.join("\n") || "no events");
      return { events };
    } catch (err) {
      await cx.mutation(api.pipeline.finishRun, { id: runId, status: "error", summary: String(err).slice(0, 500) });
      throw err;
    }
  },
});
