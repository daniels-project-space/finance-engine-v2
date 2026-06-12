import { logger, queue, task } from "@trigger.dev/sdk";
import { api, convex } from "../lib/convexClient";
import { mergeConfig, todayKey } from "../lib/appConfig";
import { loadBars } from "../lib/data";
import { artifactKey, putJsonGz } from "../lib/storage";
import { evaluateSealed, runGauntlet } from "../engine/gauntlet";
import type { Bars, StrategyDoc } from "../engine/types";
import type { Id } from "../../convex/_generated/dataModel";

const gauntletQueue = queue({ name: "gauntlet", concurrencyLimit: 4 });

export const gauntletTask = task({
  id: "run-gauntlet",
  machine: "small-2x",
  maxDuration: 1700,
  queue: gauntletQueue,
  run: async (payload: { candidateId: string }) => {
    const cx = convex();
    const candidateId = payload.candidateId as Id<"candidates">;
    const cand = await cx.query(api.candidates.get, { id: candidateId });
    if (!cand) throw new Error("candidate not found");
    const cfg = mergeConfig(await cx.query(api.pipeline.getConfig, { key: "app" }));
    const doc = JSON.parse(cand.dsl) as StrategyDoc;
    const sealTs = Date.parse(cfg.sealDate);

    await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "gauntlet" });

    // penalty box check (S1)
    if (await cx.query(api.pipeline.isPenalized, { familyHash: cand.familyHash })) {
      await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: "S1-penalty", failedReason: "family in penalty box" });
      return { passed: false, stage: "S1-penalty" };
    }

    // load data
    const primary = await loadBars(cfg.primarySymbol, cfg.tf);
    if (!primary || primary.t.length < 20_000) throw new Error("primary bars missing/short — run ingest first");
    const others: Bars[] = [];
    for (const sym of cfg.universe) {
      if (sym === cfg.primarySymbol) continue;
      const b = await loadBars(sym, cfg.tf);
      if (b && b.t.length > 15_000) others.push(b);
    }
    const primary4h = await loadBars(cfg.primarySymbol, "4h");
    if (primary4h && primary4h.t.length > 5_000) others.push(primary4h);

    const nTrials = await cx.query(api.pipeline.getCounter, { key: "trials_total" });
    await cx.mutation(api.pipeline.bumpCounter, { key: "trials_total", by: 1 });

    const report = runGauntlet({
      doc, primary, others, sealTs, floors: cfg.floors,
      nTrialsTotal: Math.max(nTrials, 10),
      log: (m) => logger.log(m),
    });

    // persist stage reports
    for (const s of report.stages) {
      await cx.mutation(api.pipeline.addGateReport, {
        candidateId, stage: s.stage, passed: s.passed, reason: s.reason,
        report: JSON.stringify(s.detail ?? {}).slice(0, 20_000), durationMs: s.durationMs,
      });
    }
    await putJsonGz(artifactKey(cand.hash, "gauntlet"), report);

    if (!report.passed) {
      await cx.mutation(api.candidates.updateStage, {
        id: candidateId, stage: "failed",
        failedStage: report.failedStage, failedReason: report.failedReason,
        metrics: JSON.stringify(report.metrics),
      });
      await cx.mutation(api.pipeline.addLesson, {
        source: cand.source, candidateId, stage: report.failedStage,
        text: `FAILED ${report.failedStage}: "${cand.name}" (${cand.hypothesis.slice(0, 90)}) — ${report.failedReason}`,
      });
      // family-level penalty after repeated failures of the same structure
      const familySeen = await cx.query(api.candidates.familySeenCount, { familyHash: cand.familyHash });
      if (familySeen >= 4) {
        await cx.mutation(api.pipeline.penalize, { familyHash: cand.familyHash, reason: `family failed ${familySeen}x`, days: 7 });
      }
      logger.log(`FAILED at ${report.failedStage}: ${report.failedReason}`);
      return { passed: false, stage: report.failedStage };
    }

    // ---- S6 sealed holdout, one-shot per hash ----
    const claim = await cx.mutation(api.pipeline.claimHoldout, { hash: cand.hash, sealTs });
    if (!claim.allowed) {
      await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: "S6-sealed", failedReason: "seal already consumed for this hash" });
      return { passed: false, stage: "S6-sealed" };
    }
    const sealed = evaluateSealed(doc, primary, report.bestParams ?? {}, sealTs, cfg.floors);
    await cx.mutation(api.pipeline.recordHoldout, { hash: cand.hash, result: JSON.stringify(sealed), passed: sealed.passed });
    await cx.mutation(api.pipeline.addGateReport, {
      candidateId, stage: "S6-sealed", passed: sealed.passed, reason: sealed.reason,
      report: JSON.stringify(sealed), durationMs: 0,
    });

    const composite = 0.5 * (report.metrics.wfPooledSharpe ?? 0) + 0.3 * sealed.sharpe + 0.2 * (report.metrics.fullSharpe ?? 0);
    const metrics = { ...report.metrics, sealedSharpe: sealed.sharpe, sealedRet: sealed.ret, sealedMaxDD: sealed.maxDD, sealedTrades: sealed.trades, composite };

    if (!sealed.passed) {
      await cx.mutation(api.candidates.updateStage, {
        id: candidateId, stage: "failed", failedStage: "S6-sealed", failedReason: sealed.reason,
        metrics: JSON.stringify(metrics), bestParams: JSON.stringify(report.bestParams ?? {}),
      });
      await cx.mutation(api.pipeline.addLesson, {
        source: cand.source, candidateId, stage: "S6-sealed",
        text: `SEALED-FAIL: "${cand.name}" passed S0–S5b then failed the sealed holdout (${sealed.reason}). In-sample machinery is fitting noise in this family.`,
      });
      await cx.mutation(api.pipeline.penalize, { familyHash: cand.familyHash, reason: "sealed holdout fail", days: 14 });
      return { passed: false, stage: "S6-sealed" };
    }

    // ---- enter paper incubation ----
    await cx.mutation(api.paper.ensureAccount, { candidateId, startEquity: cfg.paperStartEquity });
    await cx.mutation(api.candidates.updateStage, {
      id: candidateId, stage: "incubating",
      metrics: JSON.stringify(metrics), bestParams: JSON.stringify(report.bestParams ?? {}),
      composite, incubationStartedAt: Date.now(),
    });
    await cx.mutation(api.pipeline.addLesson, {
      source: cand.source, candidateId,
      text: `PASSED full gauntlet + sealed holdout: "${cand.name}" (composite ${composite.toFixed(2)}, sealed sharpe ${sealed.sharpe.toFixed(2)}). Mechanism: ${cand.hypothesis.slice(0, 120)}`,
    });
    logger.log(`PASSED -> incubating, composite=${composite.toFixed(2)}`);
    return { passed: true, composite };
  },
});
