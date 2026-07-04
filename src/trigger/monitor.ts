// Daily monitor: graduate incubated strategies, auto-promote validated ones,
// demote degrading champions. The "never replaces until validated" protocol.

import { logger, schedules } from "@trigger.dev/sdk";
import { api, convex } from "../lib/convexClient";
import { mergeConfig } from "../lib/appConfig";
import { sendTelegram } from "../lib/telegram";
import { buildBook, marginalContribution, bookQualifies, type Stream } from "../engine/book";
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
        const metrics = cand.metrics ? JSON.parse(cand.metrics) as { bootstrapP5?: number; bookQualifies?: boolean; marginalBookSharpe?: number; maxBookCorr?: number } : {};
        const band = (metrics.bootstrapP5 ?? 0) - 0.5; // tolerance: live can run half a Sharpe below the backtest 5th pct
        // CALIBRATION PASS: a candidate also qualifies for ELIGIBILITY when it is
        // BOOK-QUALIFYING (marginal book-Sharpe lift OR low-corr + positive edge,
        // from the Wave-2 book) — not only when it beats its standalone band. The
        // book is now a promotion TARGET. This only broadens eligibility; the
        // champion-swap APPROVAL gate (step 2) is unchanged.
        const bookQualifies = cfg.bookPromotion && metrics.bookQualifies === true;
        if (live >= band) {
          await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "eligible" });
          events.push(`🎓 "${cand.name}" graduated incubation (${days.toFixed(0)}d, live sharpe ${live.toFixed(2)} vs band ${band.toFixed(2)})`);
        } else if (bookQualifies) {
          await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "eligible" });
          await cx.mutation(api.pipeline.addLesson, {
            source: cand.source, candidateId,
            text: `BOOK-ELIGIBLE: "${cand.name}" missed its standalone band (live ${live.toFixed(2)} < ${band.toFixed(2)}) but qualifies as a book diversifier (marginalBookSharpe ${(metrics.marginalBookSharpe ?? 0).toFixed(2)}, maxBookCorr ${(metrics.maxBookCorr ?? 0).toFixed(2)}). Awaiting approval.`,
          });
          events.push(`📚 "${cand.name}" graduated as a BOOK DIVERSIFIER (live ${live.toFixed(2)}, marg ${(metrics.marginalBookSharpe ?? 0).toFixed(2)}, corr ${(metrics.maxBookCorr ?? 0).toFixed(2)}) — awaiting Daniel's approval`);
        } else {
          await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: "S7-paper", failedReason: `live sharpe ${live.toFixed(2)} below band ${band.toFixed(2)}` });
          await cx.mutation(api.pipeline.addLesson, {
            source: cand.source, candidateId,
            text: `INCUBATION-FAIL: "${cand.name}" live sharpe ${live.toFixed(2)} fell below its backtest confidence band — backtest optimistic for this family.`,
          });
          events.push(`📉 "${cand.name}" failed incubation (live ${live.toFixed(2)} < band ${band.toFixed(2)})`);
        }
      }

      // ---- 2. auto-promotion (UNCHANGED standalone path) + book approval gate ----
      if (cfg.autoPromote) {
        const eligibleAll = await cx.query(api.candidates.listByStage, { stage: "eligible" });
        const best = eligibleAll.filter((c) => c.composite !== undefined).sort((a, b) => (b.composite ?? 0) - (a.composite ?? 0))[0];
        const champComposite = champion?.composite ?? 0;
        let autoSwapped: string | undefined;
        if (best) {
          // STANDALONE auto-swap: unchanged — a candidate that beats the champion
          // on standalone composite by the beat ratio is auto-promoted ("auto").
          if (!champion || (best.composite ?? 0) >= champComposite * cfg.floors.championBeatRatio) {
            await cx.mutation(api.promotions.promote, { candidateId: best._id as Id<"candidates">, approvedBy: "auto", note: `composite ${(best.composite ?? 0).toFixed(2)} vs champion ${champComposite.toFixed(2)}` });
            events.push(`👑 PROMOTED "${best.name}" to champion (composite ${(best.composite ?? 0).toFixed(2)}${champion ? `, replacing "${champion.name}" — archived, rollback available` : ""})`);
            autoSwapped = best._id as string;
          }
        }
        // CALIBRATION PASS — APPROVAL GATE: book-diversifier eligibles that did NOT
        // win the standalone swap are NOT auto-promoted. They wait for Daniel's
        // manual approval (promotions.promote approvedBy:"daniel"). Surface them.
        if (cfg.bookPromotion) {
          const awaiting = eligibleAll.filter((c) =>
            (c._id as string) !== autoSwapped &&
            (champion ? (c.composite ?? 0) < champComposite * cfg.floors.championBeatRatio : false));
          if (awaiting.length) {
            events.push(`📋 ${awaiting.length} book-diversifier eligible(s) AWAITING APPROVAL (not auto-swapped): ${awaiting.map((c) => `"${c.name}" (composite ${(c.composite ?? 0).toFixed(2)})`).join(", ")}`);
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

      // ---- 4. rebuild the diversification BOOK from live paper streams ----
      // The old book only saw same-cycle in-memory survivors (and its caller was
      // dropped in the cloud refactor — it sat frozen for 11 days). The honest
      // input is what the sleeves ACTUALLY did in forward paper: daily returns
      // derived from equitySnapshots, ERC-weighted across every incubating sleeve.
      try {
        const streams: Stream[] = [];
        const nameOf: Record<string, string> = {};
        for (const cand of incubating) {
          const snaps = (await cx.query(api.paper.snapshots, { candidateId: cand._id as Id<"candidates">, limit: 3000 })) as { ts: number; equity: number }[];
          if (snaps.length < 3) continue;
          const byDay = new Map<number, number>();          // UTC day -> last equity that day
          for (const s of [...snaps].sort((a, b) => a.ts - b.ts)) byDay.set(Math.floor(s.ts / 86400_000) * 86400_000, s.equity);
          const days = [...byDay.keys()].sort((a, b) => a - b);
          if (days.length < 6) continue;
          const t: number[] = [], ret: number[] = [];
          for (let i = 1; i < days.length; i++) {
            const e0 = byDay.get(days[i - 1])!, e1 = byDay.get(days[i])!;
            if (e0 > 0) { t.push(days[i]); ret.push(e1 / e0 - 1); }
          }
          streams.push({ id: cand._id as string, t, ret });
          nameOf[cand._id as string] = cand.name;
        }
        if (streams.length >= 3) {
          const book = buildBook(streams, 365);
          const safe = (x: number) => (Number.isFinite(x) ? x : 0);
          await cx.mutation(api.book.upsert, {
            members: book.members.map((m) => ({
              candidateId: m.id, name: nameOf[m.id] ?? "?",
              weight: safe(m.weight), riskContrib: safe(m.riskContrib), standaloneSharpe: safe(m.standaloneSharpe),
            })),
            weights: book.weights.map(safe),
            stats: { sharpe: safe(book.stats.sharpe), vol: safe(book.stats.vol), maxDD: safe(book.stats.maxDD), meanRet: safe(book.stats.meanRet), nBars: book.stats.nBars },
            meanAbsCorr: safe(book.meanAbsCorr),
          });
          events.push(`📚 book rebuilt from live paper: ${book.members.length} sleeves over ${book.nBars}d, Sharpe ${safe(book.stats.sharpe).toFixed(2)}, mean|corr| ${safe(book.meanAbsCorr).toFixed(2)}`);
          // marginal-diversification metrics only once there is enough overlap to
          // mean anything — these feed the book-eligibility promotion path.
          if (book.nBars >= 20) {
            for (let i = 0; i < streams.length; i++) {
              const mc = marginalContribution(streams[i], streams.filter((_, j) => j !== i), 365);
              const qualifies = bookQualifies(mc, { minMarginalSharpe: cfg.book.minMarginalSharpe, maxCorr: cfg.book.maxCorr });
              try {
                // re-fetch: step 1 may have moved this sleeve's stage since we listed it
                const fresh = await cx.query(api.candidates.get, { id: streams[i].id as Id<"candidates"> });
                if (!fresh) continue;
                const m = fresh.metrics ? JSON.parse(fresh.metrics) as Record<string, unknown> : {};
                m.marginalBookSharpe = mc.marginalSharpe;
                m.maxBookCorr = mc.maxCorr;
                m.bookQualifies = qualifies;
                await cx.mutation(api.candidates.updateStage, { id: streams[i].id as Id<"candidates">, stage: fresh.stage, metrics: JSON.stringify(m) });
              } catch { /* per-sleeve best-effort */ }
            }
          }
        } else {
          events.push(`📚 book: only ${streams.length} sleeve(s) with ≥6d of paper history — waiting`);
        }
      } catch (e) {
        events.push(`🔴 book rebuild FAILED: ${e instanceof Error ? e.message.slice(0, 150) : e}`);
      }

      // ---- 5. staleness sentinels (a dead cron gets noticed today, not by accident) ----
      try {
        const ds = (await cx.query(api.pipeline.listDatasets, {})) as { lastTs: number }[];
        if (ds.length) {
          const newest = Math.max(...ds.map((d) => d.lastTs));
          const ageH = (now - newest) / 3600_000;
          if (ageH > 4) events.push(`⚠️ ingest STALE: newest bar ${ageH.toFixed(1)}h old`);
        }
        const runs = (await cx.query(api.pipeline.recentRuns, { limit: 40 })) as { kind: string; status: string; startedAt: number }[];
        const lastOk = (kind: string) => runs.find((r) => r.kind === kind && r.status === "ok")?.startedAt ?? 0;
        if (now - lastOk("evolve") > 8 * 3600_000) events.push(`⚠️ evolve cron STALE: no ok run in ${((now - lastOk("evolve")) / 3600_000).toFixed(0)}h`);
        if (now - lastOk("ideate-opus") > 12 * 3600_000) events.push(`⚠️ ideate cron STALE: no ok run in ${((now - lastOk("ideate-opus")) / 3600_000).toFixed(0)}h`);
      } catch (e) {
        events.push(`staleness check failed: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
      }

      // ---- 6. zombie reaper: queued/gauntlet rows that never resolved ----
      try {
        let reaped = 0;
        for (const stage of ["queued", "gauntlet"]) {
          const rows = (await cx.query(api.candidates.listByStage, { stage })) as { _id: Id<"candidates">; createdAt: number }[];
          for (const r of rows) {
            if (now - r.createdAt > 3 * 86400_000) {
              await cx.mutation(api.candidates.updateStage, {
                id: r._id, stage: "failed", failedStage: "S0-stale",
                failedReason: `reaped: stuck in ${stage} >3d (worker died or task lost)`,
              });
              reaped++;
            }
          }
        }
        if (reaped) events.push(`🧹 reaped ${reaped} stale queued/gauntlet zombie(s)`);
      } catch (e) {
        events.push(`reaper failed: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
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
