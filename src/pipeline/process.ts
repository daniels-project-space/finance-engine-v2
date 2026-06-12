// Shared pipeline logic — the SAME code runs in Trigger.dev tasks and in
// local/manual kickoff scripts, so cloud and manual cycles are identical.

import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { mergeConfig, todayKey, type AppConfig } from "../lib/appConfig";
import { loadBars } from "../lib/data";
import { artifactKey, putJsonGz } from "../lib/storage";
import { canonicalHash, familyHash, validateStrategy } from "../engine/dsl";
import { crossoverStrategies, mutateStrategy, randomStrategy, type MutationHint } from "../engine/evolve";
import { SEED_LIBRARY } from "../engine/library";
import { IMPORTED_LIBRARY } from "../engine/imports";
import { evaluateSealed, runGauntlet } from "../engine/gauntlet";
import { propose } from "../engine/llm";
import { PPY, type Bars, type StrategyDoc } from "../engine/types";

export type Log = (m: string) => void;

export async function getAppConfig(cx: ConvexHttpClient): Promise<AppConfig> {
  return mergeConfig(await cx.query(api.pipeline.getConfig, { key: "app" }));
}

// ---------------------------------------------------------------- generation
export interface GenSummary { gp: number; fresh: number; llm: number; duplicates: number; queued: number; llmSkipped: string; ids: string[] }

export async function generateBatch(cx: ConvexHttpClient, cfg: AppConfig, log: Log, scale = 1): Promise<GenSummary> {
  const summary: GenSummary = { gp: 0, fresh: 0, llm: 0, duplicates: 0, queued: 0, llmSkipped: "", ids: [] };

  const todayCount = await cx.query(api.pipeline.getCounter, { key: todayKey("candidates") });
  if (todayCount >= cfg.evo.maxCandidatesPerDay) { summary.llmSkipped = "daily candidate cap"; return summary; }

  const champion = await cx.query(api.candidates.champion, {});
  const leaders = await cx.query(api.candidates.leaderboard, { limit: 12 });
  const parentRows = [...(champion ? [champion] : []), ...leaders.filter((l) => l._id !== champion?._id)];
  // Until strategies survive, breed from the best of the fallen — near-misses
  // that reached walk-forward with a positive partial composite are the gene pool.
  if (parentRows.length < 6) {
    const board = await cx.query(api.candidates.tournament, { limit: 30 });
    const have = new Set(parentRows.map((p) => p._id));
    for (const row of board) {
      if (have.has(row._id) || (row.composite ?? 0) <= 0.05) continue;
      parentRows.push(row);
      have.add(row._id);
      if (parentRows.length >= 10) break;
    }
  }
  const hintFor = (reason?: string): MutationHint => {
    if (!reason) return undefined;
    if (/maxDD|worst month/i.test(reason)) return "risk";
    if (/positive months/i.test(reason)) return "consistency";
    if (/portfolio|symbols </i.test(reason)) return "generalize";
    if (/sharpe/i.test(reason)) return "sharpe";
    return undefined;
  };
  const parents = parentRows.map((c) => {
    const doc = JSON.parse(c.dsl) as StrategyDoc;
    // children start from the parent's PROVEN parameters, not cold defaults
    if (c.bestParams) {
      try {
        const bp = JSON.parse(c.bestParams) as Record<string, number>;
        for (const [k, v] of Object.entries(bp)) {
          const spec = doc.params?.[k];
          if (spec && Number.isFinite(v)) spec.default = Math.min(spec.max, Math.max(spec.min, spec.int ? Math.round(v) : v));
        }
      } catch { /* keep defaults */ }
    }
    return { doc, id: c._id as string, hint: hintFor(c.failedReason) };
  });

  const seedBase = (await cx.mutation(api.pipeline.bumpCounter, { key: "seed", by: 1 })) * 7919;
  const proposals: { doc: StrategyDoc; source: string; parentIds?: string[] }[] = [];

  // Library backfill: any research-backed seed or imported published strategy
  // not yet registered goes first. The founders anchor the ranking.
  for (const seedDoc of SEED_LIBRARY) {
    const hash = canonicalHash(seedDoc);
    if (!(await cx.query(api.candidates.hashExists, { hash }))) {
      proposals.push({ doc: seedDoc, source: "seed" });
    }
  }
  for (const impDoc of IMPORTED_LIBRARY) {
    const hash = canonicalHash(impDoc);
    if (!(await cx.query(api.candidates.hashExists, { hash }))) {
      proposals.push({ doc: impDoc, source: "imported" });
    }
  }

  const gpN = Math.round(cfg.evo.batchGp * scale);
  for (let i = 0; i < gpN && parents.length > 0; i++) {
    const seed = seedBase + i;
    if (parents.length >= 2 && i % 4 === 3) {
      const a = parents[i % parents.length], b = parents[(i + 1) % parents.length];
      proposals.push({ doc: crossoverStrategies(a.doc, b.doc, seed), source: "crossover", parentIds: [a.id, b.id] });
    } else {
      const p = parents[i % parents.length];
      const { doc, mutation } = mutateStrategy(p.doc, seed, p.hint);
      proposals.push({ doc, source: mutation.startsWith("repair_") ? "repair" : "mutation", parentIds: [p.id] });
    }
    summary.gp++;
  }

  const freshN = Math.round((parents.length === 0 ? cfg.evo.batchGp + cfg.evo.batchFresh : cfg.evo.batchFresh) * scale);
  for (let i = 0; i < freshN; i++) {
    proposals.push({ doc: randomStrategy(seedBase + 100_000 + i), source: "gp" });
    summary.fresh++;
  }

  // LLM lane (budget-gated; Fable -> DeepSeek fallback)
  const spentCents = await cx.query(api.pipeline.getCounter, { key: todayKey("llm_usd_cents") });
  const budgetLeft = cfg.llmDailyBudgetUsd - spentCents / 100;
  if (budgetLeft > 0.05) {
    const lessons = (await cx.query(api.pipeline.recentLessons, { limit: 25 })).map((l) => l.text);
    const championSummary = champion
      ? `"${champion.name}" composite=${champion.composite?.toFixed(2)} hypothesis: ${champion.hypothesis}`
      : "none yet";
    const result = await propose(
      { anthropic: process.env.ANTHROPIC_API_KEY, openrouter: process.env.OPENROUTER_API_KEY },
      budgetLeft, lessons, "", championSummary, cfg.evo.batchLlm,
    );
    if ("skipped" in result) summary.llmSkipped = result.skipped;
    else {
      await cx.mutation(api.pipeline.bumpCounter, { key: todayKey("llm_usd_cents"), by: Math.ceil(result.usage.costUsd * 100) });
      for (const p of result.proposals) {
        p.doc.hypothesis = `${p.doc.hypothesis} [LLM: ${result.usage.model}] ${p.rationale.slice(0, 100)}`;
        proposals.push({ doc: p.doc, source: "llm" });
        summary.llm++;
      }
      log(`LLM ${result.usage.model}: ${result.proposals.length} proposals, $${result.usage.costUsd.toFixed(3)}`);
    }
  } else summary.llmSkipped = "daily budget exhausted";

  // validate, dedupe, register
  for (const p of proposals) {
    if (validateStrategy(p.doc).length > 0) continue;
    const hash = canonicalHash(p.doc);
    if (await cx.query(api.candidates.hashExists, { hash })) { summary.duplicates++; continue; }
    const fam = familyHash(p.doc);
    const famCount = await cx.query(api.candidates.familySeenCount, { familyHash: fam });
    if (famCount >= 10) { summary.duplicates++; continue; }
    const { id, duplicate } = await cx.mutation(api.candidates.create, {
      name: p.doc.name, source: p.source, parentIds: p.parentIds,
      dsl: JSON.stringify(p.doc), hash, familyHash: fam, hypothesis: p.doc.hypothesis,
    });
    if (duplicate) { summary.duplicates++; continue; }
    await cx.mutation(api.candidates.updateStage, { id, stage: "queued" });
    await cx.mutation(api.pipeline.bumpCounter, { key: todayKey("candidates"), by: 1 });
    summary.ids.push(id as unknown as string);
    summary.queued++;
  }
  return summary;
}

// ---------------------------------------------------------------- gauntlet
export interface ProcessResult { passed: boolean; stage?: string; composite?: number }

export async function processCandidate(cx: ConvexHttpClient, candidateIdRaw: string, log: Log): Promise<ProcessResult> {
  const candidateId = candidateIdRaw as Id<"candidates">;
  const cand = await cx.query(api.candidates.get, { id: candidateId });
  if (!cand) throw new Error("candidate not found");
  const cfg = await getAppConfig(cx);
  const doc = JSON.parse(cand.dsl) as StrategyDoc;
  const sealTs = Date.parse(cfg.sealDate);

  await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "gauntlet" });

  if (await cx.query(api.pipeline.isPenalized, { familyHash: cand.familyHash })) {
    await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: "S1-penalty", failedReason: "family in penalty box" });
    return { passed: false, stage: "S1-penalty" };
  }

  // per-strategy timeframe: data + thresholds follow the candidate's tf
  const tf = doc.tf ?? (cfg.tf as "1h");
  const ppy = PPY[tf] ?? 8760;
  const primary = await loadBars(cfg.primarySymbol, tf);
  if (!primary || primary.t.length < ppy * 2.2) throw new Error(`primary ${tf} bars missing/short — run ingest first`);
  const others: Bars[] = [];
  for (const sym of cfg.universe) {
    if (sym === cfg.primarySymbol) continue;
    const b = await loadBars(sym, tf);
    if (b && b.t.length > ppy * 1.7) others.push(b);
  }
  // cross-timeframe generalization vote: one step away from the native tf
  const altTf = tf === "1h" ? "4h" : "1h";
  const primaryAlt = await loadBars(cfg.primarySymbol, altTf);
  if (primaryAlt && primaryAlt.t.length > (PPY[altTf] ?? 8760) * 1.7) others.push(primaryAlt);

  const nTrials = await cx.query(api.pipeline.getCounter, { key: "trials_total" });
  await cx.mutation(api.pipeline.bumpCounter, { key: "trials_total", by: 1 });

  const report = runGauntlet({ doc, primary, others, sealTs, floors: cfg.floors, nTrialsTotal: Math.max(nTrials, 10), log });

  for (const s of report.stages) {
    await cx.mutation(api.pipeline.addGateReport, {
      candidateId, stage: s.stage, passed: s.passed, reason: s.reason,
      report: JSON.stringify(s.detail ?? {}).slice(0, 20_000), durationMs: s.durationMs,
    });
  }
  await putJsonGz(artifactKey(cand.hash, "gauntlet"), report);
  const curvesJson = (extra?: object) => JSON.stringify({ ...(report.curves ?? {}), ...(extra ?? {}) });

  if (!report.passed) {
    // partial composite so near-misses still rank in the tournament
    const wfScore = report.metrics.portOosSharpe ?? report.metrics.wfPooledSharpe;
    const partial = wfScore !== undefined
      ? 0.5 * wfScore + 0.2 * (report.metrics.fullSharpe ?? 0)
      : undefined;
    await cx.mutation(api.candidates.updateStage, {
      id: candidateId, stage: "failed",
      failedStage: report.failedStage, failedReason: report.failedReason,
      metrics: JSON.stringify(report.metrics), curves: curvesJson(), composite: partial,
    });
    await cx.mutation(api.pipeline.addLesson, {
      source: cand.source, candidateId, stage: report.failedStage,
      text: `FAILED ${report.failedStage}: "${cand.name}" (${cand.hypothesis.slice(0, 90)}) — ${report.failedReason}`,
    });
    const familySeen = await cx.query(api.candidates.familySeenCount, { familyHash: cand.familyHash });
    if (familySeen >= 4) {
      await cx.mutation(api.pipeline.penalize, { familyHash: cand.familyHash, reason: `family failed ${familySeen}x`, days: 7 });
    }
    log(`FAILED at ${report.failedStage}: ${report.failedReason}`);
    return { passed: false, stage: report.failedStage };
  }

  // S6 sealed holdout, one-shot per hash
  const claim = await cx.mutation(api.pipeline.claimHoldout, { hash: cand.hash, sealTs });
  if (!claim.allowed) {
    await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: "S6-sealed", failedReason: "seal already consumed for this hash" });
    return { passed: false, stage: "S6-sealed" };
  }
  const sameTf = [primary, ...others.filter((b) => b.tf === primary.tf)];
  const sealed = evaluateSealed(doc, sameTf, report.bestParams ?? {}, sealTs, cfg.floors);
  await cx.mutation(api.pipeline.recordHoldout, { hash: cand.hash, result: JSON.stringify({ ...sealed, curve: undefined }), passed: sealed.passed });
  await cx.mutation(api.pipeline.addGateReport, {
    candidateId, stage: "S6-sealed", passed: sealed.passed, reason: sealed.reason,
    report: JSON.stringify({ sharpe: sealed.sharpe, ret: sealed.ret, maxDD: sealed.maxDD, trades: sealed.trades }), durationMs: 0,
  });

  const composite = 0.5 * (report.metrics.portOosSharpe ?? report.metrics.wfPooledSharpe ?? 0) + 0.3 * sealed.sharpe + 0.2 * (report.metrics.fullSharpe ?? 0);
  const metrics = { ...report.metrics, sealedSharpe: sealed.sharpe, sealedRet: sealed.ret, sealedMaxDD: sealed.maxDD, sealedCagr: sealed.cagr, sealedTrades: sealed.trades, composite };

  if (!sealed.passed) {
    await cx.mutation(api.candidates.updateStage, {
      id: candidateId, stage: "failed", failedStage: "S6-sealed", failedReason: sealed.reason,
      metrics: JSON.stringify(metrics), bestParams: JSON.stringify(report.bestParams ?? {}),
      curves: curvesJson({ sealed: sealed.curve }), composite,
    });
    await cx.mutation(api.pipeline.addLesson, {
      source: cand.source, candidateId, stage: "S6-sealed",
      text: `SEALED-FAIL: "${cand.name}" passed S0–S5b then failed the sealed holdout (${sealed.reason}). In-sample machinery is fitting noise in this family.`,
    });
    await cx.mutation(api.pipeline.penalize, { familyHash: cand.familyHash, reason: "sealed holdout fail", days: 14 });
    return { passed: false, stage: "S6-sealed" };
  }

  await cx.mutation(api.paper.ensureAccount, { candidateId, startEquity: cfg.paperStartEquity });
  await cx.mutation(api.candidates.updateStage, {
    id: candidateId, stage: "incubating",
    metrics: JSON.stringify(metrics), bestParams: JSON.stringify(report.bestParams ?? {}),
    curves: curvesJson({ sealed: sealed.curve }),
    composite, incubationStartedAt: Date.now(),
  });
  await cx.mutation(api.pipeline.addLesson, {
    source: cand.source, candidateId,
    text: `PASSED full gauntlet + sealed holdout: "${cand.name}" (composite ${composite.toFixed(2)}, sealed portfolio sharpe ${sealed.sharpe.toFixed(2)}). Mechanism: ${cand.hypothesis.slice(0, 120)}`,
  });
  const { sendTelegram } = await import("../lib/telegram");
  const target = (report.metrics.portOosSharpe ?? 0) >= 1.5 && (sealed.cagr ?? 0) >= 0.3;
  await sendTelegram(
    `${target ? "🎯 *TARGET-CLASS STRATEGY*" : "🏆 *Gauntlet survivor*"} — finance-engine-v2\n` +
    `"${cand.name}" entered 30-day paper incubation\n` +
    `Portfolio OOS Sharpe: ${(report.metrics.portOosSharpe ?? 0).toFixed(2)} · Sealed Sharpe: ${sealed.sharpe.toFixed(2)} · Sealed CAGR: ${((sealed.cagr ?? 0) * 100).toFixed(0)}% · MaxDD: ${((report.metrics.portMaxDD ?? 0) * 100).toFixed(0)}%\n` +
    `${cand.hypothesis.slice(0, 160)}`,
  );
  log(`PASSED -> incubating, composite=${composite.toFixed(2)}`);
  return { passed: true, composite };
}
