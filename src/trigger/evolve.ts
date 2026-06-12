import { logger, schedules } from "@trigger.dev/sdk";
import { api, convex } from "../lib/convexClient";
import { mergeConfig, todayKey } from "../lib/appConfig";
import { canonicalHash, familyHash, validateStrategy } from "../engine/dsl";
import { crossoverStrategies, mutateStrategy, randomStrategy } from "../engine/evolve";
import { propose } from "../engine/llm";
import type { StrategyDoc } from "../engine/types";
import { gauntletTask } from "./gauntlet";

export const evolveCycle = schedules.task({
  id: "evolve-cycle",
  cron: "20 */6 * * *",
  machine: "small-2x",
  maxDuration: 1500,
  run: async () => {
    const cx = convex();
    const runId = await cx.mutation(api.pipeline.startRun, { kind: "evolve" });
    const summary = { gp: 0, fresh: 0, llm: 0, duplicates: 0, queued: 0, llmSkipped: "" };
    try {
      const cfg = mergeConfig(await cx.query(api.pipeline.getConfig, { key: "app" }));

      // daily candidate budget
      const todayCount = await cx.query(api.pipeline.getCounter, { key: todayKey("candidates") });
      if (todayCount >= cfg.evo.maxCandidatesPerDay) {
        await cx.mutation(api.pipeline.finishRun, { id: runId, status: "ok", summary: "daily candidate cap reached" });
        return summary;
      }

      // population: champion + leaderboard
      const champion = await cx.query(api.candidates.champion, {});
      const leaders = await cx.query(api.candidates.leaderboard, { limit: 12 });
      const parents = [...(champion ? [champion] : []), ...leaders.filter((l) => l._id !== champion?._id)]
        .map((c) => ({ doc: JSON.parse(c.dsl) as StrategyDoc, id: c._id as string, composite: c.composite ?? 0 }));

      const seedBase = (await cx.mutation(api.pipeline.bumpCounter, { key: "seed", by: 1 })) * 7919;
      const proposalsToQueue: { doc: StrategyDoc; source: string; parentIds?: string[] }[] = [];

      // --- GP: mutate + crossover winners ---
      for (let i = 0; i < cfg.evo.batchGp && parents.length > 0; i++) {
        const seed = seedBase + i;
        if (parents.length >= 2 && i % 4 === 3) {
          const a = parents[i % parents.length], b = parents[(i + 1) % parents.length];
          proposalsToQueue.push({ doc: crossoverStrategies(a.doc, b.doc, seed), source: "crossover", parentIds: [a.id, b.id] });
        } else {
          const p = parents[i % parents.length];
          const { doc } = mutateStrategy(p.doc, seed);
          proposalsToQueue.push({ doc, source: "mutation", parentIds: [p.id] });
        }
        summary.gp++;
      }

      // --- fresh grammar samples (always — keeps diversity even with no parents) ---
      const freshN = parents.length === 0 ? cfg.evo.batchGp + cfg.evo.batchFresh : cfg.evo.batchFresh;
      for (let i = 0; i < freshN; i++) {
        proposalsToQueue.push({ doc: randomStrategy(seedBase + 100_000 + i), source: "gp" });
        summary.fresh++;
      }

      // --- LLM lane (budget-gated, Fable -> DeepSeek fallback) ---
      const spent = await cx.query(api.pipeline.getCounter, { key: todayKey("llm_usd_cents") });
      const budgetLeft = cfg.llmDailyBudgetUsd - spent / 100;
      if (budgetLeft > 0.05) {
        const lessons = (await cx.query(api.pipeline.recentLessons, { limit: 25 })).map((l) => l.text);
        const championSummary = champion
          ? `"${champion.name}" composite=${champion.composite?.toFixed(2)} hypothesis: ${champion.hypothesis}`
          : "none yet";
        const result = await propose(
          { anthropic: process.env.ANTHROPIC_API_KEY, openrouter: process.env.OPENROUTER_API_KEY },
          budgetLeft, lessons, "", championSummary, cfg.evo.batchLlm,
        );
        if ("skipped" in result) {
          summary.llmSkipped = result.skipped;
        } else {
          await cx.mutation(api.pipeline.bumpCounter, { key: todayKey("llm_usd_cents"), by: Math.ceil(result.usage.costUsd * 100) });
          for (const p of result.proposals) {
            p.doc.hypothesis = `${p.doc.hypothesis} [LLM: ${result.usage.model}] ${p.rationale.slice(0, 100)}`;
            proposalsToQueue.push({ doc: p.doc, source: "llm" });
            summary.llm++;
          }
          logger.log(`LLM ${result.usage.model}: ${result.proposals.length} proposals, $${result.usage.costUsd.toFixed(3)}`);
        }
      } else {
        summary.llmSkipped = "daily budget exhausted";
      }

      // --- validate, dedupe, register, queue gauntlets ---
      const toTrigger: { payload: { candidateId: string } }[] = [];
      for (const p of proposalsToQueue) {
        if (validateStrategy(p.doc).length > 0) continue;
        const hash = canonicalHash(p.doc);
        if (await cx.query(api.candidates.hashExists, { hash })) { summary.duplicates++; continue; }
        const fam = familyHash(p.doc);
        const famCount = await cx.query(api.candidates.familySeenCount, { familyHash: fam });
        if (famCount >= 10) { summary.duplicates++; continue; } // family saturated
        const { id, duplicate } = await cx.mutation(api.candidates.create, {
          name: p.doc.name, source: p.source, parentIds: p.parentIds,
          dsl: JSON.stringify(p.doc), hash, familyHash: fam, hypothesis: p.doc.hypothesis,
        });
        if (duplicate) { summary.duplicates++; continue; }
        await cx.mutation(api.candidates.updateStage, { id, stage: "queued" });
        await cx.mutation(api.pipeline.bumpCounter, { key: todayKey("candidates"), by: 1 });
        toTrigger.push({ payload: { candidateId: id as unknown as string } });
        summary.queued++;
      }
      if (toTrigger.length) await gauntletTask.batchTrigger(toTrigger);

      await cx.mutation(api.pipeline.finishRun, { id: runId, status: "ok", summary: JSON.stringify(summary) });
      logger.log(`evolve cycle: ${JSON.stringify(summary)}`);
      return summary;
    } catch (err) {
      await cx.mutation(api.pipeline.finishRun, { id: runId, status: "error", summary: String(err).slice(0, 500) });
      throw err;
    }
  },
});
