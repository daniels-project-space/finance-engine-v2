// Shared pipeline logic — the SAME code runs in Trigger.dev tasks and in
// local/manual kickoff scripts, so cloud and manual cycles are identical.

import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { mergeConfig, todayKey, type AppConfig } from "../lib/appConfig";
import { loadBars, attachOnchain } from "../lib/data";
import { artifactKey, putJsonGz, getJsonGz } from "../lib/storage";
import { canonicalHash, familyHash, validateStrategy } from "../engine/dsl";
import { crossoverStrategies, mutateStrategy, randomStrategy, mechanismFirstStrategy, mechanismKeys, recipeOf, setIcBias, MUTATION_OPS, type MutationHint, type MutationOp } from "../engine/evolve";
import { icFamilyWeights, icRankingText, type IcRankedRow } from "../engine/signals";
import { SEED_LIBRARY } from "../engine/library";
import { IMPORTED_LIBRARY } from "../engine/imports";
import { evaluateSealed, runGauntlet, runGauntletXSection, runGauntletIv, runGauntletOc, runGauntletTrend, runGauntletCombination, setRiskObjective, setMonteCarlo, type GauntletReport } from "../engine/gauntlet";
import { isCombination, type CombinationDoc } from "../engine/combination";
import { generateCombination, mutateCombination, validateCombination, combinationHash, combinationFamilyHash } from "../engine/combinationGen";
import { isXSection, alignUniverse, type XSectionDoc, type XAligned } from "../engine/xsection";
import { generateXSection, validateXSection, xsectionHash, xsectionFamilyHash } from "../engine/xsectionGen";
import { isIvSleeve, buildIvDaily, type IvSleeveDoc, type IvDaily } from "../engine/ivsleeve";
import { generateIvSleeve, validateIvSleeve, ivSleeveHash, ivSleeveFamilyHash } from "../engine/ivsleeveGen";
import { isOcSleeve, buildOcDaily, type OcSleeveDoc, type OcDaily } from "../engine/onchainsleeve";
import { generateOcSleeve, validateOcSleeve, ocSleeveHash, ocSleeveFamilyHash } from "../engine/onchainsleeveGen";
import { isTrendBeta, buildTrendDaily, type TrendBetaDoc, type TrendDaily } from "../engine/trendbeta";
import { generateTrendBeta, validateTrendBeta, trendBetaHash, trendBetaFamilyHash } from "../engine/trendbetaGen";
import { loadDvol, dvolMap, dvolCurrencyFor } from "../lib/deribit";
import { realityCheck } from "../engine/rigor";
import { buildBook, marginalContribution, bookQualifies, type Stream } from "../engine/book";
import { perSleeveSignificant, marginalAdmits, bookLevelGate } from "../engine/bookGate";
import { propose, type AgentProvider } from "../engine/llm";
import { buildFailureReport, buildFixPrompt, runFixRound, ITERATE_DSL_GUIDE, type ReportLike, type LineageEntry } from "../engine/iterate";
import { premiumOf } from "../engine/premia";
import { setBayesTuning } from "../engine/tune";
import { thompsonPick, antiThompsonPick, type Arm } from "../engine/bandit";
import { mulberry32 } from "../engine/stats";
import { PPY, type Bars, type StrategyDoc } from "../engine/types";

export type Log = (m: string) => void;

export async function getAppConfig(cx: ConvexHttpClient): Promise<AppConfig> {
  return mergeConfig(await cx.query(api.pipeline.getConfig, { key: "app" }));
}

// ============================================================ ITERATION LOOP
// Automates Daniel's propose -> diagnose -> fix process. Gauntlets a DSL doc
// IN-PROCESS (no persistence), feeds its OWN GauntletReport into a targeted-fix LLM
// prompt, repeats for K rounds capped by a token budget, and keeps the best of the
// lineage. The winner is returned to the generator as one `iterated` proposal that
// is then persisted + re-gauntleted normally. Gauntlet/floors/DSR math UNTOUCHED —
// this calls the SAME runGauntlet (read-only) and only orchestrates the lineage.

/** Gauntlet ONE DSL doc in-process and return its report (no Convex persistence).
 *  Uses the IDENTICAL runGauntlet call (same floors + binding) as processCandidate. */
async function gauntletDsl(cx: ConvexHttpClient, doc: StrategyDoc, cfg: AppConfig, sealTs: number, log: Log): Promise<GauntletReport | null> {
  const tf = doc.tf ?? (cfg.tf as "1h");
  const ppy = PPY[tf] ?? 8760;
  let primary = await loadBars(cfg.primarySymbol, tf);
  if (!primary || primary.t.length < ppy * 2.2) return null;
  if (cfg.onchain?.enabled) primary = await attachOnchain(primary, cfg.primarySymbol);
  const s4Subset = (cfg.crossSymbolSubset && cfg.crossSymbolSubset.length ? cfg.crossSymbolSubset : ["ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT", "AVAX/USDT", "LINK/USDT", "DOGE/USDT"]).filter((s) => s !== cfg.primarySymbol && cfg.universe.includes(s));
  const others: Bars[] = [];
  for (const sym of s4Subset) { const b = await loadBars(sym, tf); if (b && b.t.length > ppy * 1.7) others.push(b); }
  const altTf = tf === "1h" ? "4h" : "1h";
  const primaryAlt = await loadBars(cfg.primarySymbol, altTf);
  if (primaryAlt && primaryAlt.t.length > (PPY[altTf] ?? 8760) * 1.7) others.push(primaryAlt);
  const nTrials = Math.max(40, 10);
  return runGauntlet({
    doc, primary, others, sealTs, floors: cfg.floors, nTrialsTotal: nTrials, log,
    binding: {
      purgedWf: cfg.walkforward.purged,
      pbo: { bind: cfg.shadowRigor.pbo.bind, max: cfg.shadowRigor.pbo.max, blocks: cfg.shadowRigor.pboBlocks },
      regime: { bind: cfg.shadowRigor.regime.bind, minObs: cfg.shadowRigor.regime.minObs, minSharpe: cfg.shadowRigor.regime.minSharpe, maxPnlConcentration: cfg.shadowRigor.regime.maxPnlConcentration },
    },
  });
}

/** stage-depth score so "best of lineage" prefers the doc that reached deepest. */
const STAGE_DEPTH_ITER: Record<string, number> = { "S2-train": 2, "S3-walkforward": 3, "S4-cross-symbol": 4, "S4-portfolio": 4.5, "S5-stats": 5, "S5b-stress": 5.5, "S5c-pbo": 5.7, "S6-sealed": 6 };
function lineageScore(r: GauntletReport): number {
  if (r.passed) return 100 + (r.metrics.composite ?? r.metrics.portOosSharpe ?? r.metrics.wfPooledSharpe ?? 0);
  const depth = STAGE_DEPTH_ITER[r.failedStage ?? ""] ?? 1;
  return depth + Math.max(0, (r.metrics.wfPooledSharpe ?? 0)) * 0.1;
}

export interface IterationResult { bestDoc: StrategyDoc; bestReport: GauntletReport; lineage: LineageEntry[]; rounds: number; tokensIn: number; tokensOut: number; improved: boolean }

/**
 * Run a propose->diagnose->fix lineage starting from `seed`. Each round: gauntlet
 * the doc in-process, and if it failed, build its OWN failure report + ask the LLM
 * for a targeted fix, then gauntlet the fix. Caps at maxRounds AND a token budget.
 * Keeps the deepest/best doc of the lineage. CLI -> DeepSeek fallback per round.
 */
export async function iterateLineage(
  cx: ConvexHttpClient, seed: StrategyDoc, cfg: AppConfig, sealTs: number, log: Log,
  opts: { maxRounds: number; tokenBudget: number; provider: AgentProvider },
): Promise<IterationResult | null> {
  const lineage: LineageEntry[] = [];
  let tokensIn = 0, tokensOut = 0;
  let cur = seed;
  let best: { doc: StrategyDoc; report: GauntletReport; score: number } | null = null;
  let firstScore = -Infinity;

  for (let round = 1; round <= opts.maxRounds; round++) {
    const report = await gauntletDsl(cx, cur, cfg, sealTs, log);
    if (!report) return best ? { bestDoc: best.doc, bestReport: best.report, lineage, rounds: round - 1, tokensIn, tokensOut, improved: best.score > firstScore } : null;
    const score = lineageScore(report);
    lineage.push({ round, name: cur.name, rationale: (cur.hypothesis ?? "").slice(0, 140), failedStage: report.failedStage, oosSharpe: report.metrics.wfPooledSharpe ?? report.metrics.portOosSharpe, dsr: report.metrics.dsr, passed: report.passed });
    if (!best || score > best.score) best = { doc: cur, report, score };
    if (round === 1) firstScore = score;
    log(`  iterate round ${round}/${opts.maxRounds}: "${cur.name}" ${report.passed ? "PASSED" : `died ${report.failedStage}`} (OOS ${(report.metrics.wfPooledSharpe ?? 0).toFixed(2)}, DSR ${(report.metrics.dsr ?? 0).toFixed(2)}, score ${score.toFixed(2)})`);

    if (report.passed) break;                          // a winner — stop the lineage
    if (round === opts.maxRounds) break;               // out of rounds
    if (tokensIn + tokensOut >= opts.tokenBudget) { log(`  iterate: token budget hit (${tokensIn + tokensOut})`); break; }

    // build THIS candidate's structured failure report + the targeted-fix prompt
    const failureReport = buildFailureReport(cur, report as ReportLike);
    const prompt = buildFixPrompt(ITERATE_DSL_GUIDE, failureReport, lineage, round + 1, opts.maxRounds);
    // Use the same explicitly selected subscription for every repair round.
    let fix: { doc: StrategyDoc; rationale: string } | null = null;
    try {
      const r = await runFixRound(prompt, opts.provider, cfg.iterate?.model ?? undefined);
      tokensIn += r.usage.inputTokens; tokensOut += r.usage.outputTokens;
      fix = r.proposal;
    } catch (e) {
      log(`  iterate ${opts.provider} subscription fix failed (${e instanceof Error ? e.message.slice(0, 100) : e})`);
    }
    if (!fix) { log(`  iterate: no valid fix at round ${round}; stopping lineage`); break; }
    fix.doc.hypothesis = `${fix.doc.hypothesis} [iterated r${round + 1}: fix for ${report.failedStage}] ${fix.rationale.slice(0, 90)}`;
    fix.doc.name = `iter_${round + 1}_${(seed.name ?? "x").slice(0, 16)}`;
    cur = fix.doc;
  }

  if (!best) return null;
  return { bestDoc: best.doc, bestReport: best.report, lineage, rounds: lineage.length, tokensIn, tokensOut, improved: best.score > firstScore + 0.01 };
}

// ---------------------------------------------------------------- generation
export interface GenSummary { gp: number; fresh: number; llm: number; duplicates: number; queued: number; llmSkipped: string; ids: string[] }

export async function generateBatch(cx: ConvexHttpClient, cfg: AppConfig, log: Log, scale = 1): Promise<GenSummary> {
  const summary: GenSummary = { gp: 0, fresh: 0, llm: 0, duplicates: 0, queued: 0, llmSkipped: "", ids: [] };

  const todayCount = await cx.query(api.pipeline.getCounter, { key: todayKey("candidates") });
  if (todayCount >= cfg.evo.maxCandidatesPerDay) { summary.llmSkipped = "daily candidate cap"; return summary; }
  const agentProvider = await cx.query(api.pipeline.getAgentProvider, {}) as AgentProvider;
  log(`agent intelligence: ${agentProvider} subscription`);

  // CAPABILITY #4: arm the risk-managed ranking objective for the generation pass
  // too, so the iterate lineage's best-of-lineage pick (lineageScore -> composite)
  // also prefers lower-drawdown fixes. Flag-gated + reversible; no-op when off.
  setRiskObjective(cfg.riskObjective);
  setMonteCarlo(cfg.montecarlo); // non-binding Monte-Carlo diagnostic (no-op unless enabled)

  // CALIBRATION PASS: IC-steered generation. Read the persisted signal-IC report
  // once per batch; bias the GP grammar sampler toward high-IC crypto-leaf
  // families and build the ranking text for the LLM prompt. Cold-start safe — no
  // report (or icSteering off) leaves the bias null (uniform) and the text empty.
  let icRanking = "";
  try {
    if (cfg.icSteering) {
      const report = await cx.query(api.signalIc.get, {}) as { ranked?: IcRankedRow[] } | null;
      const ranked = report?.ranked;
      setIcBias(icFamilyWeights(ranked));
      icRanking = icRankingText(ranked);
      if (icRanking) log(`IC-steering ON: ${ranked?.length ?? 0} ranked signals; GP+LLM prefer high-IC inputs`);
      else log(`IC-steering ON but no usable report yet — uniform sampling (cold start)`);
    } else {
      setIcBias(null);
    }
  } catch (e) { setIcBias(null); log(`IC-steering skipped: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }

  // The GP lane (crossoverStrategies / mutateStrategy) only knows how to breed plain
  // DSL StrategyDocs. The sleeve families (xsection / trendbeta / iv / onchain /
  // core4 portfolio) carry a `kind` and have NO DSL longEntry/params — they have
  // their own dedicated generators on their own lanes. If one of them leaks into the
  // breeding pool (they can rank top of the leaderboard by composite), crossover does
  // `clone(donor.longExit)` on undefined (-> SyntaxError "undefined" is not valid
  // JSON) or `doc.params[x_*] = …` on an undefined params (-> TypeError "Cannot set
  // properties of undefined"). So we filter the parent pool to breedable DSL docs.
  const isBreedableDsl = (c: { dsl?: string }): boolean => {
    if (!c.dsl) return false;
    try {
      const d = JSON.parse(c.dsl) as { kind?: string; longEntry?: unknown; params?: unknown };
      return !d.kind && d.longEntry != null && d.params != null && typeof d.params === "object";
    } catch { return false; }
  };
  const champion = await cx.query(api.candidates.champion, {});
  const leaders = await cx.query(api.candidates.leaderboard, { limit: 12 });
  const parentRows = [...(champion && isBreedableDsl(champion) ? [champion] : []), ...leaders.filter((l) => l._id !== champion?._id && isBreedableDsl(l))];
  // Until strategies survive, breed from the best of the fallen — near-misses
  // that reached walk-forward with a positive partial composite are the gene pool.
  if (parentRows.length < 6) {
    const board = await cx.query(api.candidates.tournament, { limit: 30 });
    const have = new Set(parentRows.map((p) => p._id));
    for (const row of board) {
      if (have.has(row._id) || (row.composite ?? 0) <= 0.05 || !isBreedableDsl(row)) continue;
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
    // GENERATION-STEER: how many of the 5 perps this parent was WF-positive on at
    // S4 (stored in metrics). Used to bias breeding toward cross-symbol generalizers
    // rather than single-symbol (BTC) overfits — the dominant cause of death.
    let crossSym = 0;
    try { crossSym = (JSON.parse(c.metrics ?? "{}") as { crossSymbolPositive?: number }).crossSymbolPositive ?? 0; } catch { /* none */ }
    return { doc, id: c._id as string, hint: hintFor(c.failedReason), composite: c.composite ?? 0, family: c.familyHash, crossSym };
  });

  // ---- intelligence upgrade: learned (Thompson) selection ----
  // Knowledge ledger read once per cycle. Empty => cold-start => uniform behavior.
  const ledger = await cx.query(api.ledger.ledgerSnapshot, {});
  const ledgerByMech = new Map(ledger.map((r) => [r.mechanism, r]));
  // Soft dead-end suppression from the failure memory: a recipe that keeps
  // dying at the sealed holdout / cross-symbol stage gets its Beta failure
  // param inflated (collapses its odds without zeroing them).
  // TOOLKIT lane: the `graft_macro` operator (graft a proven block onto an entry)
  // is only an eligible bandit arm when the toolkit is enabled (flag-reversible).
  const opsForBandit = MUTATION_OPS.filter((op) => op !== "graft_macro" || cfg.toolkit?.enabled === true);
  const recipeArms: Arm[] = opsForBandit.map((op) => {
    const key = `gp-op:${op}`;
    const r = ledgerByMech.get(key);
    const suppression = r ? 2 * r.failedSealed + r.failedS4 : 0;
    return { key, alpha: r?.alpha ?? 1, beta: r?.beta ?? 1, suppression };
  });
  const epsilon = Number(process.env.EVOLUTION_EPSILON ?? 0.15);
  const banditRng = mulberry32(((await cx.query(api.pipeline.getCounter, { key: "trials_total" })) || 1) * 2654435761 >>> 0);
  const ledgerMean = (mech: string) => {
    const r = ledgerByMech.get(mech);
    return r && r.meanComposite ? r.meanComposite : 0;
  };
  // global mean composite across all recipes (fresh/llm expected baseline)
  const globalMean = ledger.length
    ? ledger.reduce((s, r) => s + (r.meanComposite || 0) * r.compositeN, 0) / Math.max(1, ledger.reduce((s, r) => s + r.compositeN, 0))
    : 0;
  // fitness-proportional parent picker, weighted by composite (floored) AND by
  // cross-symbol reach: a parent WF-positive on more of the 5 perps gets bred more
  // often, so the gene pool drifts toward generalizers. 0/1 symbols => x1 (no
  // boost), each extra symbol adds 40% up to ~2.6x at the full 5/5. Composite still
  // dominates magnitude; this only re-ranks within the survivors. No gauntlet gate
  // is touched — purely a generation-side breeding preference.
  const parentWeights = parents.map((p) => Math.max(0.05, p.composite) * (1 + 0.4 * Math.max(0, (p.crossSym ?? 0) - 1)));
  const parentWeightSum = parentWeights.reduce((a, b) => a + b, 0);
  const pickParent = (): typeof parents[number] => {
    if (!parents.length) return parents[0];
    let r = banditRng() * parentWeightSum;
    for (let k = 0; k < parents.length; k++) { r -= parentWeights[k]; if (r <= 0) return parents[k]; }
    return parents[parents.length - 1];
  };

  const seedBase = (await cx.mutation(api.pipeline.bumpCounter, { key: "seed", by: 1 })) * 7919;
  type Proposal = { doc: StrategyDoc | XSectionDoc | IvSleeveDoc | OcSleeveDoc | TrendBetaDoc | CombinationDoc; source: string; parentIds?: string[]; mechanism?: string; parentComposite?: number; expectedComposite?: number; wild?: boolean };
  const proposals: Proposal[] = [];

  // Library backfill: any research-backed seed or imported published strategy
  // not yet registered goes first. The founders anchor the ranking.
  for (const seedDoc of SEED_LIBRARY) {
    const hash = canonicalHash(seedDoc);
    if (!(await cx.query(api.candidates.hashExists, { hash }))) {
      proposals.push({ doc: seedDoc, source: "seed", mechanism: "seed" });
    }
  }
  for (const impDoc of IMPORTED_LIBRARY) {
    const hash = canonicalHash(impDoc);
    if (!(await cx.query(api.candidates.hashExists, { hash }))) {
      proposals.push({ doc: impDoc, source: "imported", mechanism: "imported" });
    }
  }

  const gpN = Math.round(cfg.evo.batchGp * scale);
  // force ~10% of GP children to be deliberately WILD (anti-Thompson recipe) so
  // exploration never collapses even when one operator dominates the ledger.
  const wildQuota = ledger.length ? Math.max(1, Math.round(0.1 * gpN)) : 0;
  let wildUsed = 0;
  // NOVELTY RETRY: ~75-80% of raw GP/crossover output was re-rolling already-seen
  // hashes and dying at the dedupe gate below — wasted slots. Re-roll a colliding
  // child with a shifted seed (bounded) so the batch ships mostly-new genomes.
  const batchHashes = new Set<string>();
  const isNovel = async (doc: StrategyDoc): Promise<boolean> => {
    try {
      const h = canonicalHash(doc);
      if (batchHashes.has(h)) return false;
      if (await cx.query(api.candidates.hashExists, { hash: h })) return false;
      batchHashes.add(h);
      return true;
    } catch { return true; } // let the validator/dedupe gate decide later
  };
  for (let i = 0; i < gpN && parents.length > 0; i++) {
    const seed = seedBase + i;
    if (parents.length >= 2 && i % 4 === 3) {
      const a = pickParent(), b = pickParent();
      let xdoc = crossoverStrategies(a.doc, b.doc, seed);
      for (let att = 1; att <= 3 && !(await isNovel(xdoc)); att++) xdoc = crossoverStrategies(a.doc, b.doc, seed + att * 7_777_777);
      proposals.push({
        doc: xdoc, source: "crossover", parentIds: [a.id, b.id],
        mechanism: "crossover", parentComposite: Math.max(a.composite, b.composite),
        expectedComposite: ledgerMean("crossover") || Math.max(a.composite, b.composite) * 0.9, wild: false,
      });
    } else {
      const p = pickParent();
      // bandit recipe: deliberate wild pick for the quota, else Thompson sample
      let forcedOp: MutationOp | "" = "";
      let wild = false;
      if (recipeArms.length && wildUsed < wildQuota && banditRng() < 0.34) {
        const anti = antiThompsonPick(recipeArms);
        forcedOp = (anti.replace("gp-op:", "") as MutationOp);
        wild = true; wildUsed++;
      } else if (recipeArms.length) {
        const pick = thompsonPick(recipeArms, banditRng, epsilon);
        if (pick.key) forcedOp = pick.key.replace("gp-op:", "") as MutationOp;
        wild = pick.wild;
      }
      let child = mutateStrategy(p.doc, seed, p.hint, { forcedOp });
      for (let att = 1; att <= 3 && !(await isNovel(child.doc)); att++) child = mutateStrategy(p.doc, seed + att * 7_777_777, p.hint, { forcedOp });
      const { doc, mutation } = child;
      const mechanism = recipeOf(mutation.startsWith("repair_") ? "repair" : "mutation", mutation);
      const expected = (ledgerMean(mechanism) || p.composite * 0.9);
      proposals.push({
        doc, source: mutation.startsWith("repair_") ? "repair" : "mutation", parentIds: [p.id],
        mechanism, parentComposite: p.composite, expectedComposite: expected, wild,
      });
    }
    summary.gp++;
  }

  const freshN = Math.round((parents.length === 0 ? cfg.evo.batchGp + cfg.evo.batchFresh : cfg.evo.batchFresh) * scale);
  const mechFirst = cfg.generation.mechanismFirst === true;
  for (let i = 0; i < freshN; i++) {
    if (mechFirst) {
      // MECHANISM-FIRST: instantiate/vary/combine a coherent template (the rebuilt
      // quant-style discovery). mechanism key carries the template for attribution.
      const { doc, mechanism } = mechanismFirstStrategy(seedBase + 100_000 + i, 0.15, cfg.toolkit?.enabled ? (cfg.toolkit.composeShare ?? 0.2) : 0);
      proposals.push({ doc, source: "gp", mechanism, expectedComposite: globalMean, wild: false });
    } else {
      proposals.push({ doc: randomStrategy(seedBase + 100_000 + i), source: "gp", mechanism: "fresh", expectedComposite: globalMean, wild: false });
    }
    summary.fresh++;
  }
  if (mechFirst) log(`mechanism-first lane ON (templates: ${mechanismKeys().join(", ")})`);

  // ---- CROSS-SECTIONAL lane (momentum + PURE non-momentum, long-flat) -------
  // Universe-wide rank sleeves routed to the adapted gauntlet (S4 skipped). The
  // first cycle showed trend-flavored sleeves re-correlate with the momentum
  // cluster (0.79-0.92), so the lane now PRIORITIZES pure NON-MOMENTUM rank
  // signals (funding-carry / basis-dislocation / OI-washout / LSR-contrarian) —
  // each driven purely by microstructure with NO trend term — to seek a sleeve
  // that is positive AND orthogonal to momentum. Reversal omitted (spike: dead).
  if (cfg.xsection?.enabled) {
    const flavors: import("../engine/xsectionGen").XSectionFlavor[] = [
      "carry_funding", "basis_disloc", "oi_washout", "lsr_contrarian", "liquidity", "size", "trend", "trend_composite",
    ];
    const xsN = Math.max(1, Math.round((cfg.xsection.perCycle ?? 4) * scale));
    for (let i = 0; i < xsN; i++) {
      const flavor = flavors[i % flavors.length];
      const xdoc = generateXSection(seedBase + 200_000 + i, flavor);
      proposals.push({ doc: xdoc, source: "xsection", mechanism: (xdoc as { mechanism?: string }).mechanism ?? "xsection", expectedComposite: globalMean, wild: false });
      summary.fresh++;
    }
  }

  // ---- IV-TIMING lane (options-IV, the orthogonal diversifier) --------------
  // Long-flat BTC/ETH perp timing on the Deribit DVOL implied-vol regime. The
  // first genuinely-orthogonal sleeve family (~0.18 corr to momentum). Routes to
  // the adapted IV gauntlet + the book gate. Gated by cfg.ivsleeve.enabled.
  if (cfg.ivsleeve?.enabled) {
    const ivN = Math.max(1, Math.round((cfg.ivsleeve.perCycle ?? 2) * scale));
    for (let i = 0; i < ivN; i++) {
      const ivdoc = generateIvSleeve(seedBase + 300_000 + i);
      proposals.push({ doc: ivdoc, source: "ivsleeve", mechanism: "iv_timing", expectedComposite: globalMean, wild: false });
      summary.fresh++;
    }
  }

  // ---- ON-CHAIN TIMING lane (MVRV/NVT valuation, the strongest sleeve found) -
  // Long-flat BTC/ETH perp timing on the on-chain valuation regime (long when
  // cheap). The A/B winner (BTC MVRV OOS 0.96). Routes to the adapted on-chain
  // gauntlet + the book gate. Gated by cfg.ocsleeve.enabled.
  if (cfg.ocsleeve?.enabled) {
    const ocN = Math.max(1, Math.round((cfg.ocsleeve.perCycle ?? 2) * scale));
    for (let i = 0; i < ocN; i++) {
      const ocdoc = generateOcSleeve(seedBase + 400_000 + i);
      proposals.push({ doc: ocdoc, source: "onchain", mechanism: "oc_valuation", expectedComposite: globalMean, wild: false });
      summary.fresh++;
    }
  }

  // TREND-BETA lane: risk-managed long beta (long-flat close>SMA) on BTC/ETH/SOL.
  // The "safer than HODL" family — captures the up-trend, sits out deep bears.
  // Routes to the adapted trend gauntlet + the book/forward-paper gate. Gated by
  // cfg.trendbeta.enabled.
  if (cfg.trendbeta?.enabled) {
    const tbN = Math.max(1, Math.round((cfg.trendbeta.perCycle ?? 3) * scale));
    for (let i = 0; i < tbN; i++) {
      const tbdoc = generateTrendBeta(seedBase + 500_000 + i);
      proposals.push({ doc: tbdoc, source: "trendbeta", mechanism: "trend_beta", expectedComposite: globalMean, wild: false });
      summary.fresh++;
    }
  }

  // COMBINATION lane: the strategy-COMBINATION / portfolio-composition generator —
  // the #1 capability gap. Generates COMBINED candidates (multi-coin PORTFOLIOS like
  // Daniel's CORE-4, and OVERLAYS like trend×regime) judged by the gauntlet as ONE
  // unit (the COMBINED OOS stream through the SAME floors/DSR/bootstrap). Mechanism
  // attribution: "portfolio" / "overlay" so the bandit learns which combos survive.
  // Gated by cfg.combination.enabled (default off; flag-reversible).
  if (cfg.combination?.enabled) {
    const cbN = Math.max(1, Math.round((cfg.combination.perCycle ?? 4) * scale));
    // REFINEMENT (breed-from-winners): half the cycle is BRED from combinations that
    // already reached incubation/eligibility (local search around proven Sharpe-1.2+
    // structures via mutateCombination); the rest stay fresh-random for exploration.
    let winners: CombinationDoc[] = [];
    try {
      const pool = [
        ...await cx.query(api.candidates.listByStage, { stage: "incubating", limit: 50 }),
        ...await cx.query(api.candidates.listByStage, { stage: "eligible", limit: 50 }),
      ];
      winners = pool.map((c) => { try { const d = JSON.parse(c.dsl); return isCombination(d) ? d : null; } catch { return null; } }).filter((d): d is CombinationDoc => !!d);
    } catch { /* no winners yet -> all fresh */ }
    const nBred = winners.length ? Math.round(cbN * 0.5) : 0;
    for (let i = 0; i < cbN; i++) {
      const cbdoc = i < nBred ? mutateCombination(winners[i % winners.length], seedBase + 650_000 + i) : generateCombination(seedBase + 600_000 + i);
      if (validateCombination(cbdoc).length > 0) continue;
      const mech = (i < nBred ? "bred_" : "") + (cbdoc.mode === "overlay" ? "overlay" : "portfolio");
      proposals.push({ doc: cbdoc, source: "combination", mechanism: mech, expectedComposite: globalMean, wild: false });
      summary.fresh++;
    }
    log(`combination lane ON (${cbN}/cycle: ${nBred} bred from ${winners.length} winners + ${cbN - nBred} fresh)`);
  }

  // LLM lane. Anthropic goes through the subscription Claude CLI (NO API key),
  // which now runs in BOTH the VPS and the Trigger cloud image (the claude bin
  // is baked in and authed from the injected CLAUDE_CODE_OAUTH_TOKEN). On any CLI
  // failure propose() falls back to DeepSeek (a non-Anthropic backup). The
  // flat-rate subscription is treated as free for the budget gate; the per-token
  // figure is logged as a metric only. EVOLUTION_DISABLE_CLI is an optional local
  // override (default unset => CLI enabled).
  const spentCents = await cx.query(api.pipeline.getCounter, { key: todayKey("llm_usd_cents") });
  const budgetLeft = cfg.llmDailyBudgetUsd - spentCents / 100;
  const allowCli = process.env.EVOLUTION_DISABLE_CLI !== "1";
  if (budgetLeft > 0.05 || allowCli) {
    const lessons = (await cx.query(api.pipeline.recentLessons, { limit: 25 })).map((l) => l.text);
    const championSummary = champion
      ? `"${champion.name}" composite=${champion.composite?.toFixed(2)} hypothesis: ${champion.hypothesis}`
      : "none yet";
    const result = await propose(
      { openrouter: process.env.OPENROUTER_API_KEY },
      budgetLeft, lessons, "", championSummary, cfg.evo.batchLlm,
      // WAVE-3b: premium-anchored prompt behind the DEFAULT-FALSE flag.
      { allowClaudeCli: allowCli, anchored: cfg.generation.premiumAnchoredGen, icRanking, provider: agentProvider },
    );
    if ("skipped" in result) summary.llmSkipped = result.skipped;
    else {
      // subscription CLI is flat-rate: only the (billed) OpenRouter fallback
      // should consume the USD budget counter.
      if (result.usage.provider === "openrouter") {
        await cx.mutation(api.pipeline.bumpCounter, { key: todayKey("llm_usd_cents"), by: Math.ceil(result.usage.costUsd * 100) });
      }
      for (const p of result.proposals) {
        p.doc.hypothesis = `${p.doc.hypothesis} [LLM: ${result.usage.model}] ${p.rationale.slice(0, 100)}`;
        proposals.push({ doc: p.doc, source: "llm", mechanism: "llm", expectedComposite: globalMean, wild: false });
        summary.llm++;
      }
      log(`LLM ${result.usage.provider}/${result.usage.model}: ${result.proposals.length} proposals (metric $${result.usage.costUsd.toFixed(3)})`);

      // ---- ITERATION LOOP (propose -> diagnose -> fix, Daniel-style) ----------
      // When enabled, take the first LLM proposal(s) and ITERATE on their OWN
      // gauntlet failures for K rounds, keeping the best of each lineage. The winner
      // is added as one `iterated` proposal (persisted + re-gauntleted normally) so
      // the bandit/ledger learns whether iteration produces survivors. Flag-gated,
      // budget-capped; the gauntlet math is untouched (gauntletDsl reuses runGauntlet).
      if (cfg.iterate?.enabled && allowCli && result.proposals.length) {
        const sealTsIter = Date.parse(cfg.sealDate);
        const maxRounds = Math.max(1, Math.min(6, cfg.iterate.maxRounds ?? 3));
        const nLineages = Math.max(1, Math.min(cfg.iterate.lineagesPerCycle ?? 1, result.proposals.length));
        const tokenBudget = cfg.iterate.tokenBudget ?? 300_000;
        for (let li = 0; li < nLineages; li++) {
          try {
            const seedDoc = result.proposals[li].doc;
            log(`iterate: lineage ${li + 1}/${nLineages} from "${seedDoc.name}" (≤${maxRounds} rounds)`);
            const it = await iterateLineage(cx, seedDoc, cfg, sealTsIter, log, { maxRounds, tokenBudget, provider: agentProvider });
            if (it && it.rounds > 1) {
              it.bestDoc.hypothesis = `${it.bestDoc.hypothesis} [iterated ${it.rounds}r, ${it.improved ? "improved" : "explored"}]`;
              proposals.push({ doc: it.bestDoc, source: "llm", mechanism: "iterated", expectedComposite: globalMean, wild: false });
              summary.llm++;
              log(`iterate: lineage done — ${it.rounds} rounds, best ${it.bestReport.passed ? "PASSED" : "died " + it.bestReport.failedStage} (OOS ${(it.bestReport.metrics.wfPooledSharpe ?? 0).toFixed(2)}), ${it.improved ? "IMPROVED over round 1" : "no improvement"}, ~${it.tokensIn + it.tokensOut} tokens`);
            }
          } catch (e) { log(`iterate lineage ${li + 1} skipped: ${e instanceof Error ? e.message.slice(0, 100) : e}`); }
        }
      }
    }
  } else summary.llmSkipped = "daily budget exhausted";

  // validate, dedupe, register
  for (const p of proposals) {
    // CROSS-SECTIONAL / IV docs use their own validate/hash/family (not StrategyDoc).
    let hash: string, fam: string, premium: string | undefined;
    if (isXSection(p.doc)) {
      if (validateXSection(p.doc).length > 0) continue;
      hash = xsectionHash(p.doc); fam = xsectionFamilyHash(p.doc); premium = "xsection";
    } else if (isIvSleeve(p.doc)) {
      if (validateIvSleeve(p.doc).length > 0) continue;
      hash = ivSleeveHash(p.doc); fam = ivSleeveFamilyHash(p.doc); premium = "ivsleeve";
    } else if (isOcSleeve(p.doc)) {
      if (validateOcSleeve(p.doc).length > 0) continue;
      hash = ocSleeveHash(p.doc); fam = ocSleeveFamilyHash(p.doc); premium = "onchain";
    } else if (isTrendBeta(p.doc)) {
      if (validateTrendBeta(p.doc).length > 0) continue;
      hash = trendBetaHash(p.doc); fam = trendBetaFamilyHash(p.doc); premium = "trendbeta";
    } else if (isCombination(p.doc)) {
      if (validateCombination(p.doc).length > 0) continue;
      hash = combinationHash(p.doc); fam = combinationFamilyHash(p.doc); premium = "combination";
    } else {
      const sdoc = p.doc as StrategyDoc;
      if (validateStrategy(sdoc).length > 0) continue;
      hash = canonicalHash(sdoc); fam = familyHash(sdoc);
      try { premium = premiumOf(sdoc); } catch { premium = undefined; }
    }
    if (await cx.query(api.candidates.hashExists, { hash })) { summary.duplicates++; continue; }
    const famCount = await cx.query(api.candidates.familySeenCount, { familyHash: fam });
    if (famCount >= 10) { summary.duplicates++; continue; }
    const mechanism = p.mechanism ?? "fresh";
    const { id, duplicate } = await cx.mutation(api.candidates.create, {
      name: p.doc.name, source: p.source, parentIds: p.parentIds,
      dsl: JSON.stringify(p.doc), hash, familyHash: fam, hypothesis: p.doc.hypothesis, mechanism, premium,
    });
    if (duplicate) { summary.duplicates++; continue; }
    await cx.mutation(api.candidates.updateStage, { id, stage: "queued" });
    // provenance + ledger attempt bump (the bandit's prior). Best-effort: a
    // ledger hiccup must never break candidate generation.
    try {
      await cx.mutation(api.ledger.recordProvenance, {
        candidateId: id as Id<"candidates">, mechanism, family: fam,
        parentComposite: p.parentComposite, expectedComposite: p.expectedComposite, wild: !!p.wild,
      });
    } catch (e) { log(`ledger provenance skipped: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
    await cx.mutation(api.pipeline.bumpCounter, { key: todayKey("candidates"), by: 1 });
    summary.ids.push(id as unknown as string);
    summary.queued++;
  }
  return summary;
}

// ---------------------------------------------------------------- gauntlet
export interface ProcessResult { passed: boolean; stage?: string; composite?: number }

/** In-memory accumulator for the batch-level Reality Check (Feature 3, shadow)
 *  AND the Wave-2 diversification book (Feature A). Each entry is the deployed-
 *  portfolio OOS return stream (with its timestamp axis) of an S4+ survivor. */
export type ShadowOosCollector = { candidateId: string; name: string; t: number[]; ret: number[] }[];

export interface ProcessOpts {
  /** when present, S4+ survivors push their portfolio OOS returns for batch RC */
  shadowCollector?: ShadowOosCollector;
}

export async function processCandidate(cx: ConvexHttpClient, candidateIdRaw: string, log: Log, popts: ProcessOpts = {}): Promise<ProcessResult> {
  const candidateId = candidateIdRaw as Id<"candidates">;
  const cand = await cx.query(api.candidates.get, { id: candidateId });
  if (!cand) throw new Error("candidate not found");
  const cfg = await getAppConfig(cx);
  const rawDoc = JSON.parse(cand.dsl) as StrategyDoc | XSectionDoc | IvSleeveDoc | OcSleeveDoc | TrendBetaDoc | CombinationDoc;
  const sealTs = Date.parse(cfg.sealDate);
  // CAPABILITY #4 — RISK-MANAGED GENERATION OBJECTIVE (flag-gated, reversible).
  // Arm the bounded drawdown tilt applied to metrics.composite at the END of every
  // runGauntlet* (after all pass/fail decisions). Runs for ALL candidate kinds
  // (dsl/xsection/iv/oc/trend/combination) before routing. No-op unless enabled —
  // composite is byte-identical to before when riskObjective.enabled !== true. The
  // gauntlet pass/fail math is NOT touched; this only re-ranks the survivors.
  setRiskObjective(cfg.riskObjective);
  setMonteCarlo(cfg.montecarlo); // non-binding Monte-Carlo diagnostic (no-op unless enabled)

  // CROSS-SECTIONAL routing: an xsection sleeve takes the adapted gauntlet path
  // (S4 cross-symbol skipped; honesty tests on the single universe-wide stream).
  if (isXSection(rawDoc)) {
    return processXSectionCandidate(cx, candidateId, cand, rawDoc, cfg, sealTs, log);
  }
  // IV-TIMING routing: a single-coin options-IV perp-timing sleeve -> IV gauntlet.
  if (isIvSleeve(rawDoc)) {
    return processIvCandidate(cx, candidateId, cand, rawDoc, cfg, sealTs, log);
  }
  // ON-CHAIN routing: a single-coin on-chain valuation-timing sleeve -> Oc gauntlet.
  if (isOcSleeve(rawDoc)) {
    return processOcCandidate(cx, candidateId, cand, rawDoc, cfg, sealTs, log);
  }
  // TREND-BETA routing: a single-coin risk-managed-beta sleeve -> trend gauntlet.
  if (isTrendBeta(rawDoc)) {
    return processTrendCandidate(cx, candidateId, cand, rawDoc, cfg, sealTs, log);
  }
  // COMBINATION routing: a multi-block portfolio/overlay -> combination gauntlet,
  // which judges the COMBINED OOS stream as one unit (same floors/DSR/bootstrap).
  if (isCombination(rawDoc)) {
    return processCombinationCandidate(cx, candidateId, cand, rawDoc, cfg, sealTs, log);
  }
  const doc = rawDoc as StrategyDoc;

  // WAVE-3b: select the tuner for this process. DEFAULT FALSE => legacy adaptive
  // random-search + hill-climb (unchanged). When `bayesTuning` is on, tune() and
  // tuneWithConfigs() delegate to the TPE Bayesian optimizer (same interface).
  setBayesTuning(cfg.tuning.bayesTuning, cfg.tuning.bayes);

  // intelligence upgrade: at every terminal point, attribute the outcome back
  // to the recipe (updates the bandit's Beta posteriors + ledger means) and,
  // when a candidate beats its recipe's expectation, log a SURPRISE lesson so
  // the discovery feeds the LLM prompt next cycle. Best-effort — a ledger
  // hiccup must never break the gauntlet.
  const SURPRISE_THRESHOLD = Number(process.env.EVOLUTION_SURPRISE ?? 0.25);
  const finalizeLedger = async (reachedStage: string, composite?: number, promoted = false) => {
    try {
      const res = await cx.mutation(api.ledger.recordOutcome, { candidateId, reachedStage, composite, promoted }) as
        { surprise: number | null; mechanism?: string; wild?: boolean } | null;
      const surprise = res?.surprise ?? null;
      const mech = res?.mechanism ?? cand.mechanism ?? "unknown";
      const wild = res?.wild ?? false;
      if (surprise !== null && composite !== undefined) {
        await cx.mutation(api.candidates.setSurprise, { id: candidateId, surprise });
        await cx.mutation(api.pipeline.bumpCounter, { key: todayKey("surprise_n"), by: 1 });
        // surprise gating: a recipe must have a few attempts before a "beat"
        // counts (avoids first-win noise), and the margin must clear the bar.
        const attempts = (await cx.query(api.ledger.mechanismMean, { mechanism: mech })).attempts;
        if (surprise >= SURPRISE_THRESHOLD && attempts >= 3) {
          await cx.mutation(api.pipeline.bumpCounter, { key: todayKey("surprise_hits"), by: 1 });
          await cx.mutation(api.ledger.recordSurprise, {
            candidateId, mechanism: mech, expected: composite - surprise, actual: composite, surprise, wild, reachedStage,
          });
          await cx.mutation(api.pipeline.addLesson, {
            source: cand.source, candidateId, stage: reachedStage,
            text: `SURPRISE +${surprise.toFixed(2)}: ${wild ? "wild " : ""}recipe "${mech}" beat its expectation (composite ${composite.toFixed(2)}) reaching ${reachedStage} — ${cand.hypothesis.slice(0, 90)}`,
          });
        }
      }
    } catch (e) { log(`ledger finalize skipped: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
    // WAVE-3b ADDITIVE: attribute the outcome to the candidate's premium family
    // so the engine learns which premia pay. Independent best-effort block — a
    // premiumStats hiccup must never affect the gauntlet or the mechanism ledger.
    try {
      const premium = (cand as { premium?: string }).premium;
      if (premium) await cx.mutation(api.premium.recordPremiumOutcome, { premium, reachedStage, composite });
    } catch (e) { log(`premium finalize skipped: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
  };

  await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "gauntlet" });

  if (await cx.query(api.pipeline.isPenalized, { familyHash: cand.familyHash })) {
    await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: "S1-penalty", failedReason: "family in penalty box" });
    await finalizeLedger("S1-penalty");
    return { passed: false, stage: "S1-penalty" };
  }

  // per-strategy timeframe: data + thresholds follow the candidate's tf
  const tf = doc.tf ?? (cfg.tf as "1h");
  const ppy = PPY[tf] ?? 8760;
  let primary = await loadBars(cfg.primarySymbol, tf);
  if (!primary || primary.t.length < ppy * 2.2) throw new Error(`primary ${tf} bars missing/short — run ingest first`);
  // ON-CHAIN: attach forward-filled, lagged on-chain features to the primary so
  // strategies using mvrv/activeaddr/nvt/exnetflow/stablesupply can read them
  // (BTC/ETH-only coverage; no-op for other symbols). Gated by cfg.onchain.enabled.
  if (cfg.onchain?.enabled) primary = await attachOnchain(primary, cfg.primarySymbol);
  // S4 SUBSET CAP: the live universe is now ~24 perps, so validating the S4
  // cross-symbol loop against ALL of them would run ~23 per-symbol walk-forwards
  // per candidate and blow the 1700s gauntletTask ceiling. Cap S4 to a fixed
  // REPRESENTATIVE subset spanning large/mid cap (the S4 FLOOR values are
  // unchanged — only the count of symbols validated against). Members not in the
  // current universe are skipped. The full universe is still available for the
  // cross-sectional lane (which evaluates over all of it).
  const s4Subset = (cfg.crossSymbolSubset && cfg.crossSymbolSubset.length
    ? cfg.crossSymbolSubset
    : ["ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT", "AVAX/USDT", "LINK/USDT", "DOGE/USDT"]
  ).filter((s) => s !== cfg.primarySymbol && cfg.universe.includes(s));
  log(`S4 cross-symbol subset (${s4Subset.length}): ${s4Subset.join(", ")}`);
  const others: Bars[] = [];
  for (const sym of s4Subset) {
    const b = await loadBars(sym, tf);
    if (b && b.t.length > ppy * 1.7) others.push(b);
  }
  // cross-timeframe generalization vote: one step away from the native tf
  const altTf = tf === "1h" ? "4h" : "1h";
  const primaryAlt = await loadBars(cfg.primarySymbol, altTf);
  if (primaryAlt && primaryAlt.t.length > (PPY[altTf] ?? 8760) * 1.7) others.push(primaryAlt);

  // DSR TRIAL-SCOPE FIX (2026-06-23): the Deflated-Sharpe N must be the number of
  // trials in the SAME selection process that produced THIS candidate — i.e. the
  // structurally-equivalent strategy variants explored within its family — NOT a
  // lifetime monotonic count of every unrelated strategy the engine has ever run.
  // The old all-time `trials_total` (~2000) inflated the deflation benchmark sr0
  // without bound, collapsing every candidate's DSR to ~0 regardless of merit, so
  // the S5 gate had become a wall no strategy could pass (Bailey & Lopez de Prado
  // define N as the breadth of the search that selected the candidate). We scope N
  // to the candidate's structural family (fingerprints sharing familyHash) and
  // floor it at the per-strategy parameter-search breadth (~tuneTrials) so even a
  // first-of-family is still honestly deflated for its own optimization. minDSR
  // (0.95) and every other floor are UNCHANGED — this corrects N, not the bar.
  const DSR_MIN_FAMILY_TRIALS = 40; // grounds singleton families in their own WF tuning breadth (tuneTrials 25-40)
  const familyTrials = await cx.query(api.candidates.familySeenCount, { familyHash: cand.familyHash });
  const nTrials = Math.max(familyTrials, DSR_MIN_FAMILY_TRIALS);
  // keep the lifetime counter as telemetry only (read by monitor/analytics); it no
  // longer feeds DSR deflation.
  await cx.mutation(api.pipeline.bumpCounter, { key: "trials_total", by: 1 });

  const report = runGauntlet({
    doc, primary, others, sealTs, floors: cfg.floors, nTrialsTotal: Math.max(nTrials, 10), log,
    // CALIBRATION PASS: binding gates that CHANGE pass/fail (Daniel-approved).
    binding: {
      purgedWf: cfg.walkforward.purged,
      pbo: { bind: cfg.shadowRigor.pbo.bind, max: cfg.shadowRigor.pbo.max, blocks: cfg.shadowRigor.pboBlocks },
      regime: {
        bind: cfg.shadowRigor.regime.bind,
        minObs: cfg.shadowRigor.regime.minObs,
        minSharpe: cfg.shadowRigor.regime.minSharpe,
        maxPnlConcentration: cfg.shadowRigor.regime.maxPnlConcentration,
      },
    },
    shadowRigor: cfg.shadowRigor.compute ? {
      enabled: true,
      pboBlocks: cfg.shadowRigor.pboBlocks,
      pboWarnAt: cfg.shadowRigor.pboWarnAt,
      stabilityWarnAt: cfg.shadowRigor.stabilityWarnAt,
      regimeMinObs: cfg.shadowRigor.regimeMinObs,
      regimeMinSharpeWarnAt: cfg.shadowRigor.regimeMinSharpeWarnAt,
      // WAVE-2 Feature B: capacity/impact (shadow), only if enabled in config
      capacity: cfg.capacity.enabled ? {
        enabled: true,
        k: cfg.capacity.k,
        capFloorFrac: cfg.capacity.capFloorFrac,
        capFloorAbs: cfg.capacity.capFloorAbs,
        refAumUsd: cfg.capacity.refAumUsd,
        advWindow: cfg.capacity.advWindow,
      } : { enabled: false },
    } : { enabled: false },
  });

  // Batch-level Reality Check (Feature 3) + diversification book (Feature A):
  // any S4+ survivor contributes its deployed-portfolio OOS stream (with the
  // timestamp axis, for book correlation alignment) to the cycle's collector.
  if (popts.shadowCollector && report.portfolioOos && report.portfolioOos.ret.length >= 30) {
    popts.shadowCollector.push({ candidateId: candidateIdRaw, name: cand.name, t: report.portfolioOos.t, ret: report.portfolioOos.ret });
  }

  for (const s of report.stages) {
    await cx.mutation(api.pipeline.addGateReport, {
      candidateId, stage: s.stage, passed: s.passed, reason: s.reason,
      report: JSON.stringify(s.detail ?? {}).slice(0, 20_000), durationMs: s.durationMs,
    });
  }
  // strip the (heavy) OOS stream before persisting the artifact; metrics already
  // carry the scalar shadow-rigor numbers.
  await putJsonGz(artifactKey(cand.hash, "gauntlet"), { ...report, portfolioOos: undefined });
  const curvesJson = (extra?: object) => JSON.stringify({ ...(report.curves ?? {}), ...(extra ?? {}) });

  if (!report.passed) {
    // ---- BOOK-MARGINAL PROMOTION GATE (ready receiver) ----------------------
    // A candidate that FAILED the standalone S5-DSR hurdle is not necessarily
    // worthless: a genuinely-positive, low-correlation sleeve is a good BOOK
    // component (n uncorrelated sleeves ~ sqrt(n) book Sharpe). When marginalGate
    // is on, we evaluate exactly such a candidate against the persistent admitted
    // book: (A) relaxed-but-real per-sleeve significance, (B) marginal book
    // accretion + correlation cap, (C) the WHOLE book must clear the book-level
    // honesty bar. ONLY if (A)&(B)&(C) all pass do we admit + route to incubation.
    // No gauntlet floor is touched; sealed holdout + paper stay downstream. Today
    // this PROMOTES NOTHING (no diversified book clears level-C) — it is live and
    // ready for when uncorrelated sleeves arrive.
    if (
      cfg.book.marginalGate &&
      report.failedStage === "S5-stats" &&
      (report.failedReason ?? "").startsWith("DSR") &&
      report.portfolioOos && report.portfolioOos.ret.length >= 100
    ) {
      try {
        const admitted = await bookGatePromote(cx, cand, candidateId, report, cfg, ppy, log);
        if (admitted) {
          await finalizeLedger("incubating", report.metrics.portOosSharpe);
          return { passed: true, composite: report.metrics.portOosSharpe };
        }
      } catch (e) { log(`book-gate skipped: ${e instanceof Error ? e.message.slice(0, 100) : e}`); }
    }

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
    // GENERALIZER EXEMPTION: only penalize genuine dead-ends. A family that reached
    // S4-portfolio (got PAST the cross-symbol gate) or was WF-positive on >=2 perps
    // is a proven cross-sectional generalizer whose failure here is "portfolio Sharpe
    // a bit low", not "does not generalize" — those are exactly the genes the breeder
    // needs, so we keep them in the gene pool instead of boxing them. Dead-ends that
    // never clear S2/S3 (cross<2, never reached S4-portfolio) are still penalized.
    const reachedPortfolio = (report.failedStage ?? "") === "S4-portfolio"
      || ["S5-stats", "S5b-stress", "S6-sealed"].includes(report.failedStage ?? "");
    const generalizes = reachedPortfolio || (report.metrics.crossSymbolPositive ?? 0) >= 2;
    if (familySeen >= 4 && !generalizes) {
      await cx.mutation(api.pipeline.penalize, { familyHash: cand.familyHash, reason: `family failed ${familySeen}x`, days: 7 });
    }
    log(`FAILED at ${report.failedStage}: ${report.failedReason}`);
    await finalizeLedger(report.failedStage ?? "failed", partial);
    return { passed: false, stage: report.failedStage };
  }

  // S6 sealed holdout, one-shot per hash
  const claim = await cx.mutation(api.pipeline.claimHoldout, { hash: cand.hash, sealTs });
  if (!claim.allowed) {
    await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: "S6-sealed", failedReason: "seal already consumed for this hash" });
    await finalizeLedger("S6-sealed");
    return { passed: false, stage: "S6-sealed" };
  }
  const sameTf = [primary, ...others.filter((b) => b.tf === primary.tf)];
  const sealed = evaluateSealed(doc, sameTf, report.bestParams ?? {}, sealTs, cfg.floors);
  await cx.mutation(api.pipeline.recordHoldout, { hash: cand.hash, result: JSON.stringify({ ...sealed, curve: undefined }), passed: sealed.passed });
  await cx.mutation(api.pipeline.addGateReport, {
    candidateId, stage: "S6-sealed", passed: sealed.passed, reason: sealed.reason,
    report: JSON.stringify({ sharpe: sealed.sharpe, ret: sealed.ret, maxDD: sealed.maxDD, trades: sealed.trades }), durationMs: 0,
  });

  const rawComposite = 0.5 * (report.metrics.portOosSharpe ?? report.metrics.wfPooledSharpe ?? 0) + 0.3 * sealed.sharpe + 0.2 * (report.metrics.fullSharpe ?? 0);
  // SIMPLICITY BIAS (selection only — does NOT touch the gauntlet floors/pass-fail).
  // A gentle tie-breaker on the breeding/ranking composite: simpler survivors are
  // preferred to breed from, because simple = robust (Daniel's 2-rule mechanism beat
  // 40-node monsters). Penalty caps at ~8% for the most complex; ~0 for lean docs.
  const _cx = ((): number => {
    const cnt = (e: unknown): number => { if (!e || typeof e !== "object") return 0; let k = 1; const o = e as Record<string, unknown>; for (const f of ["a", "b", "src", "period"]) if (o[f]) k += cnt(o[f]); return k; };
    const d = JSON.parse(cand.dsl) as { longEntry?: unknown; longExit?: unknown; shortEntry?: unknown; shortExit?: unknown; params?: object };
    const nodes = cnt(d.longEntry) + cnt(d.longExit) + cnt(d.shortEntry) + cnt(d.shortExit);
    const nParams = d.params ? Object.keys(d.params).length : 0;
    return Math.min(0.08, Math.max(0, (nodes - 12) * 0.002 + (nParams - 3) * 0.01)); // lean (<=12 nodes, <=3 params) => ~0
  })();
  const composite = rawComposite * (1 - _cx);
  const metrics = { ...report.metrics, sealedSharpe: sealed.sharpe, sealedRet: sealed.ret, sealedMaxDD: sealed.maxDD, sealedCagr: sealed.cagr, sealedTrades: sealed.trades, composite, rawComposite, complexityPenalty: _cx };

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
    await finalizeLedger("S6-sealed", composite);
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
  await finalizeLedger("incubating", composite);
  return { passed: true, composite };
}

// ----------------------------------------------- Feature 3: batch Reality Check
export interface RealityCheckBatchResult {
  ran: boolean;
  nCandidates: number;
  bestName?: string;
  bestRcP?: number;
  bestSpaP?: number;
  perCandidateP?: { candidateId: string; name: string; familyWiseP: number }[];
  note?: string;
}

/**
 * White's Reality Check / Hansen's SPA over the cycle's S4+ survivors (those
 * that produced a deployed-portfolio OOS stream). SHADOW MODE: stores a
 * run-level metric + per-candidate family-wise p on each candidate's metrics
 * JSON, and logs the result. NEVER changes a pass/fail or composite.
 *
 * Call ONCE at the end of a cycle with the collector populated by
 * processCandidate(..., { shadowCollector }).
 */
export async function runRealityCheckBatch(
  cx: ConvexHttpClient, collector: ShadowOosCollector, log: Log,
): Promise<RealityCheckBatchResult> {
  const cfg = await getAppConfig(cx);
  if (!cfg.shadowRigor.compute || !cfg.shadowRigor.realityCheck) return { ran: false, nCandidates: collector.length, note: "disabled" };
  if (collector.length < 2) return { ran: false, nCandidates: collector.length, note: "need >=2 S4+ survivors" };

  const rc = realityCheck(collector.map((c) => c.ret), { nReps: cfg.shadowRigor.rcReps });
  const best = rc.bestIndex >= 0 ? collector[rc.bestIndex] : undefined;
  const per = collector.map((c, i) => ({ candidateId: c.candidateId, name: c.name, familyWiseP: rc.perCandidateP[i] }));

  // shadow-persist: merge familyWiseP into each candidate's metrics JSON (best-effort)
  for (const p of per) {
    try {
      const cand = await cx.query(api.candidates.get, { id: p.candidateId as Id<"candidates"> });
      if (!cand) continue;
      const m = cand.metrics ? JSON.parse(cand.metrics) : {};
      m.rcFamilyWiseP = p.familyWiseP;
      m.rcWouldFail = p.familyWiseP > cfg.shadowRigor.rcWarnAt;
      await cx.mutation(api.candidates.updateStage, { id: p.candidateId as Id<"candidates">, stage: cand.stage, metrics: JSON.stringify(m) });
    } catch (e) { log(`RC metric patch skipped: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
  }

  log(`shadow-rigor RC: ${collector.length} survivors, best="${best?.name}" familyWiseP=${rc.bestRcP.toFixed(3)} spaP=${rc.bestSpaP.toFixed(3)} (warnAt ${cfg.shadowRigor.rcWarnAt})${rc.bestRcP > cfg.shadowRigor.rcWarnAt ? " WOULD-FAIL" : ""}`);
  return { ran: true, nCandidates: collector.length, bestName: best?.name, bestRcP: rc.bestRcP, bestSpaP: rc.bestSpaP, perCandidateP: per };
}

// ----------------------------------------------- Feature A: diversification book
export interface BookBatchResult {
  ran: boolean;
  nMembers: number;
  bookSharpe?: number;
  meanAbsCorr?: number;
  note?: string;
}

/**
 * Build the WAVE-2 SHADOW diversification book from this cycle's S4+ survivors'
 * deployed-portfolio OOS streams (ERC risk-parity weighting), persist it to the
 * Convex `book` singleton, and write each survivor's marginal contribution
 * (book-Sharpe lift, max book correlation, bookQualifies flag) onto its metrics
 * JSON. SHADOW MODE: NEVER changes promotion or the composite.
 *
 * Build inputs are the cycle's S4+ survivors (the streams available in-memory).
 * Until candidates actually survive, the collector is empty and the book stays
 * empty — the machinery still runs and persists an empty book. Cross-cycle
 * incubating candidates are not re-streamed here (their raw OOS paths are not
 * persisted); the book is rebuilt each cycle from the freshest survivors.
 *
 * Call ONCE at the end of a cycle with the same collector used for the RC batch.
 */
export async function runBookBatch(
  cx: ConvexHttpClient, collector: ShadowOosCollector, log: Log, ppy = 8760,
): Promise<BookBatchResult> {
  const cfg = await getAppConfig(cx);
  if (!cfg.book.enabled) return { ran: false, nMembers: collector.length, note: "disabled" };

  const streams: Stream[] = collector.map((c) => ({ id: c.candidateId, t: c.t, ret: c.ret }));
  const book = buildBook(streams, ppy);

  // persist the book singleton (best-effort)
  try {
    await cx.mutation(api.book.upsert, {
      members: book.members.map((m, i) => ({
        candidateId: streams[i]?.id ?? "?",
        name: collector[i]?.name ?? "?",
        weight: m.weight,
        riskContrib: m.riskContrib,
        standaloneSharpe: m.standaloneSharpe,
      })),
      weights: book.weights,
      stats: book.stats,
      meanAbsCorr: book.meanAbsCorr,
    });
  } catch (e) { log(`book upsert skipped: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }

  // per-survivor marginal contribution vs the OTHER members (leave-one-out), and
  // shadow-persist marginalBookSharpe / maxBookCorr / bookQualifies onto metrics.
  for (let i = 0; i < collector.length; i++) {
    const candidate: Stream = streams[i];
    const others = streams.filter((_, j) => j !== i);
    const mc = marginalContribution(candidate, others, ppy);
    const qualifies = bookQualifies(mc, { minMarginalSharpe: cfg.book.minMarginalSharpe, maxCorr: cfg.book.maxCorr });
    try {
      const cand = await cx.query(api.candidates.get, { id: collector[i].candidateId as Id<"candidates"> });
      if (!cand) continue;
      const m = cand.metrics ? JSON.parse(cand.metrics) : {};
      m.marginalBookSharpe = mc.marginalSharpe;
      m.maxBookCorr = mc.maxCorr;
      m.bookQualifies = qualifies;
      await cx.mutation(api.candidates.updateStage, { id: collector[i].candidateId as Id<"candidates">, stage: cand.stage, metrics: JSON.stringify(m) });
      log(`shadow-book: "${collector[i].name}" marginalSharpe=${mc.marginalSharpe.toFixed(2)} maxCorr=${mc.maxCorr.toFixed(2)} qualifies=${qualifies ? "Y" : "N"}`);
    } catch (e) { log(`book metric patch skipped: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
  }

  log(`shadow-book: ${book.members.length} members, bookSharpe=${book.stats.sharpe.toFixed(2)} meanAbsCorr=${book.meanAbsCorr.toFixed(2)} weights=[${book.weights.map((w) => w.toFixed(2)).join(", ")}]`);
  return { ran: true, nMembers: book.members.length, bookSharpe: book.stats.sharpe, meanAbsCorr: book.meanAbsCorr };
}

// ------------------------------------------------ BOOK-MARGINAL PROMOTION GATE
/** Persistent admitted-book streams live in R2 under this stable key. Each entry
 *  is one admitted sleeve's deployed-portfolio OOS stream {id,name,t,ret}. */
const ADMITTED_BOOK_KEY = artifactKey("book", "admitted");
type AdmittedSleeve = { id: string; name: string; t: number[]; ret: number[] };

/**
 * Evaluate an S5-DSR-failed candidate (with a valid portfolio OOS stream) as a
 * BOOK SLEEVE: (A) relaxed-but-real per-sleeve significance, (B) marginal
 * accretion + correlation cap vs the persistent admitted book, (C) the WHOLE
 * resulting book must clear the book-level honesty bar. Returns true (and routes
 * the candidate to incubation + persists the enlarged admitted book) ONLY when
 * all three pass — otherwise false (caller falls through to normal failure).
 * Touches NO gauntlet floor. Promotes nothing until a diversified book clears C.
 */
async function bookGatePromote(
  cx: ConvexHttpClient,
  cand: { name: string; hypothesis: string; source: string; hash: string },
  candidateId: Id<"candidates">,
  report: GauntletReport,
  cfg: AppConfig,
  ppy: number,
  log: Log,
): Promise<boolean> {
  const oos = report.portfolioOos!;
  const b = cfg.book;
  // (A) relaxed-but-real per-sleeve significance (bootstrap + deflated from the
  // stream; permutation/PBO unavailable on a DSR-early-exit, so we rely on the
  // self-contained bootstrap/deflated tests, which already reject noise).
  const A = perSleeveSignificant(
    { ret: Float64Array.from(oos.ret), ppy, nTrials: 40, permP: report.metrics.permutationP, pbo: report.metrics.pbo },
    { minBootLo: b.sleeveMinBootLo, minDeflatedSharpe: b.sleeveMinDeflated, maxPermP: cfg.floors.maxPermutationP, maxPbo: 0.5 },
  );
  if (!A.passes) { log(`book-gate (A) reject "${cand.name}": ${A.reasons.join("; ")}`); return false; }

  // load the persistent admitted book streams from R2 (empty on first ever pass)
  const admitted = (await getJsonGz<AdmittedSleeve[]>(ADMITTED_BOOK_KEY)) ?? [];
  const memberStreams: Stream[] = admitted.map((a) => ({ id: a.id, t: a.t, ret: Float64Array.from(a.ret) }));
  const candStream: Stream = { id: candidateId as string, t: oos.t, ret: Float64Array.from(oos.ret) };

  // (B) marginal accretion + correlation cap
  const B = marginalAdmits(candStream, memberStreams, ppy, { minMarginalSharpe: b.minMarginalSharpe, maxCorr: b.maxCorr });
  if (!B.admits) { log(`book-gate (B) reject "${cand.name}": ${B.reason}`); return false; }

  // (C) the WHOLE prospective book must clear the book-level honesty bar
  const prospective = [...memberStreams, candStream];
  const C = bookLevelGate(prospective, ppy, prospective.length, {
    minBookSharpe: b.bookMinSharpe, minBookDeflatedSharpe: b.bookMinDeflated, maxMeanAbsCorr: b.bookMaxMeanCorr,
  });
  log(`book-gate "${cand.name}": A=pass B=${B.reason} | book(${C.nMembers}) sharpe=${C.bookSharpe.toFixed(2)} deflated=${C.bookDeflatedSharpe.toFixed(2)} divRatio=${C.diversificationRatio.toFixed(2)} meanCorr=${C.meanAbsCorr.toFixed(2)} -> C=${C.passes ? "PASS" : "FAIL"}${C.passes ? "" : " (" + C.reasons.join("; ") + ")"}`);

  // FORWARD-PAPER PATH: (A) significance + (B) diversification already proved this
  // is an HONEST, book-accretive sleeve (not noise, not overfit). The book-level
  // deflated-1.0 bar (C) is the REAL-MONEY standard; we do NOT require it to start
  // PAPER forward-testing. If forwardPaper is on, admit to paper even when (C)
  // fails — capped at forwardPaperMaxSleeves so the paper book stays diversified-
  // sized, not a dumping ground. If (C) passes it's a full book member as before.
  // Real-money graduation (paper -> eligible -> champion) stays strict downstream.
  const forwardOnly = !C.passes;
  if (forwardOnly) {
    if (!b.forwardPaper) return false;                       // forward-paper disabled => keep the strict wall
    if (memberStreams.length >= b.forwardPaperMaxSleeves) {
      log(`forward-paper full (${memberStreams.length}/${b.forwardPaperMaxSleeves}) — not admitting "${cand.name}"`);
      return false;
    }
  }

  // ---- ADMIT: persist the enlarged book + route to paper incubation ----------
  const newAdmitted: AdmittedSleeve[] = [...admitted, { id: candidateId as string, name: cand.name, t: oos.t, ret: oos.ret }];
  await putJsonGz(ADMITTED_BOOK_KEY, newAdmitted);
  const metrics = { ...report.metrics, bookAdmitted: 1, forwardPaper: forwardOnly ? 1 : 0, bookSharpe: C.bookSharpe, bookDeflated: C.bookDeflatedSharpe, bookDivRatio: C.diversificationRatio, marginalBookSharpe: B.marginal.marginalSharpe, maxBookCorr: B.marginal.maxCorr };
  await cx.mutation(api.paper.ensureAccount, { candidateId, startEquity: cfg.paperStartEquity });
  await cx.mutation(api.candidates.updateStage, {
    id: candidateId, stage: "incubating",
    metrics: JSON.stringify(metrics), bestParams: JSON.stringify(report.bestParams ?? {}),
    curves: JSON.stringify(report.curves ?? {}),
    composite: report.metrics.portOosSharpe, incubationStartedAt: Date.now(),
  });
  await cx.mutation(api.pipeline.addLesson, {
    source: cand.source, candidateId,
    text: forwardOnly
      ? `FORWARD-PAPER: "${cand.name}" passed the real significance battery (bootCI>0, deflated(p5) ${A.deflatedSharpe.toFixed(2)}, perm/PBO) + is book-accretive (marg ${B.marginal.marginalSharpe.toFixed(2)}, corr ${B.marginal.maxCorr.toFixed(2)}) but the book is below the deflated-1.0 real-money bar. Routed to PAPER forward-testing to build a live track record. Real-money promotion stays strict.`
      : `BOOK-ADMITTED: "${cand.name}" failed standalone S5-DSR but joined the diversified book (book Sharpe ${C.bookSharpe.toFixed(2)}, deflated ${C.bookDeflatedSharpe.toFixed(2)}, divRatio ${C.diversificationRatio.toFixed(2)}, ${C.nMembers} sleeves). Entered 30-day paper incubation as a book component.`,
  });
  log(`${forwardOnly ? "FORWARD-PAPER" : "BOOK-ADMITTED"} -> incubating: "${cand.name}" (paper book now ${newAdmitted.length} sleeves)`);
  return true;
}

// ====================================================================
// CROSS-SECTIONAL candidate processing (adapted gauntlet + same downstream).
// ====================================================================
async function processXSectionCandidate(
  cx: ConvexHttpClient,
  candidateId: Id<"candidates">,
  cand: { name: string; hypothesis: string; source: string; hash: string; familyHash: string },
  doc: XSectionDoc,
  cfg: AppConfig,
  sealTs: number,
  log: Log,
): Promise<ProcessResult> {
  await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "gauntlet" });
  const tf = doc.tf ?? "4h";
  const ppy = PPY[tf] ?? 2190;

  // build the aligned universe over the candidate's tf (dev grid = all bars; the
  // gauntlet splits pre/post seal internally). Restrict to symbols with history.
  const barsList: { symbol: string; bars: import("../engine/types").Bars }[] = [];
  for (const sym of cfg.universe) {
    const b = await loadBars(sym, tf);
    if (b && b.t.length > ppy * 1.7) barsList.push({ symbol: sym, bars: b });
  }
  if (barsList.length < 6) {
    await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: "S0-static", failedReason: `only ${barsList.length} universe symbols with data` });
    return { passed: false, stage: "S0-static" };
  }
  const aligned: XAligned = alignUniverse(barsList);
  // sealed-window aligned universe (bars >= sealTs) for the holdout
  const sealedBarsList = barsList.map(({ symbol, bars }) => {
    const idx = bars.t.findIndex((t) => t >= sealTs);
    if (idx < 0) return null;
    const sl = (a: number[]) => a.slice(idx);
    const sealed: import("../engine/types").Bars = { symbol, tf: bars.tf, t: sl(bars.t), o: sl(bars.o), h: sl(bars.h), l: sl(bars.l), c: sl(bars.c), v: sl(bars.v), fundingT: bars.fundingT?.filter((t) => t >= sealTs), fundingR: bars.fundingT ? bars.fundingR?.filter((_, i) => (bars.fundingT as number[])[i] >= sealTs) : undefined };
    return { symbol, bars: sealed };
  }).filter((x): x is { symbol: string; bars: import("../engine/types").Bars } => x !== null);
  const alignedSealed = sealedBarsList.length >= 6 ? alignUniverse(sealedBarsList) : undefined;

  const nTrials = await cx.query(api.candidates.familySeenCount, { familyHash: cand.familyHash });
  await cx.mutation(api.pipeline.bumpCounter, { key: "trials_total", by: 1 });

  const report = runGauntletXSection({ doc, aligned, alignedSealed, sealTs, floors: cfg.floors, nTrialsTotal: Math.max(nTrials, 40), log });

  for (const s of report.stages) {
    await cx.mutation(api.pipeline.addGateReport, { candidateId, stage: s.stage, passed: s.passed, reason: s.reason, report: JSON.stringify(s.detail ?? {}).slice(0, 20_000), durationMs: s.durationMs });
  }
  const curvesJson = JSON.stringify(report.curves ?? {});

  if (!report.passed) {
    const partial = report.metrics.wfPooledSharpe !== undefined ? 0.5 * report.metrics.wfPooledSharpe : undefined;
    // BOOK-GATE: a cross-sectional sleeve that failed standalone S5x-DSR is exactly
    // the diversifier we want — route it through the same book-marginal gate.
    if (cfg.book.marginalGate && report.failedStage === "S5x-stats" && (report.failedReason ?? "").startsWith("DSR") && report.portfolioOos && report.portfolioOos.ret.length >= 100) {
      try {
        const admitted = await bookGatePromote(cx, cand, candidateId, report, cfg, ppy, log);
        if (admitted) return { passed: true, composite: report.metrics.portOosSharpe };
      } catch (e) { log(`xsection book-gate skipped: ${e instanceof Error ? e.message.slice(0, 100) : e}`); }
    }
    await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: report.failedStage, failedReason: report.failedReason, metrics: JSON.stringify(report.metrics), curves: curvesJson, composite: partial });
    await cx.mutation(api.pipeline.addLesson, { source: cand.source, candidateId, stage: report.failedStage, text: `XSECTION FAILED ${report.failedStage}: "${cand.name}" — ${report.failedReason}` });
    log(`XSECTION FAILED at ${report.failedStage}: ${report.failedReason}`);
    return { passed: false, stage: report.failedStage };
  }

  // PASSED the adapted gauntlet (incl its own sealed) -> paper incubation
  await cx.mutation(api.paper.ensureAccount, { candidateId, startEquity: cfg.paperStartEquity });
  await cx.mutation(api.candidates.updateStage, {
    id: candidateId, stage: "incubating",
    metrics: JSON.stringify(report.metrics), bestParams: JSON.stringify(report.bestParams ?? {}),
    curves: curvesJson, composite: report.metrics.composite ?? report.metrics.portOosSharpe, incubationStartedAt: Date.now(),
  });
  await cx.mutation(api.pipeline.addLesson, { source: cand.source, candidateId, text: `XSECTION PASSED: "${cand.name}" cross-sectional sleeve (OOS Sharpe ${(report.metrics.portOosSharpe ?? 0).toFixed(2)}, dsr ${(report.metrics.dsr ?? 0).toFixed(2)}) -> 30-day paper incubation. ${cand.hypothesis.slice(0, 100)}` });
  log(`XSECTION PASSED -> incubating (OOS Sharpe ${(report.metrics.portOosSharpe ?? 0).toFixed(2)})`);
  return { passed: true, composite: report.metrics.composite };
}

// ====================================================================
// IV-TIMING candidate processing (options-IV perp-timing sleeve).
// ====================================================================
async function processIvCandidate(
  cx: ConvexHttpClient,
  candidateId: Id<"candidates">,
  cand: { name: string; hypothesis: string; source: string; hash: string; familyHash: string },
  doc: IvSleeveDoc,
  cfg: AppConfig,
  sealTs: number,
  log: Log,
): Promise<ProcessResult> {
  await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "gauntlet" });
  const ppy = 365;
  const cur = dvolCurrencyFor(doc.symbol);
  if (!cur) {
    await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: "S0-static", failedReason: `no DVOL for ${doc.symbol}` });
    return { passed: false, stage: "S0-static" };
  }
  const bars = await loadBars(doc.symbol, "1d");
  const dvolSeries = await loadDvol(cur);
  if (!bars || !dvolSeries) {
    await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: "S0-static", failedReason: "missing perp bars or DVOL series" });
    return { passed: false, stage: "S0-static" };
  }
  const dm = dvolMap(dvolSeries);
  const daily: IvDaily = buildIvDaily(bars, dm, doc.rvWin);
  // sealed-window slice (days >= sealTs)
  const sealIdx = daily.t.findIndex((t) => t >= sealTs);
  const sl = <T>(a: T[]): T[] => sealIdx >= 0 ? a.slice(sealIdx) : [];
  const dailySealed: IvDaily | undefined = sealIdx >= 0 && daily.t.length - sealIdx > 60
    ? { t: sl(daily.t), ret: sl(daily.ret), dvol: sl(daily.dvol), rv: sl(daily.rv), funding: sl(daily.funding) }
    : undefined;

  const nTrials = await cx.query(api.candidates.familySeenCount, { familyHash: cand.familyHash });
  await cx.mutation(api.pipeline.bumpCounter, { key: "trials_total", by: 1 });

  const report = runGauntletIv({ doc, daily, dailySealed, sealTs, floors: cfg.floors, nTrialsTotal: Math.max(nTrials, 40), log });
  for (const s of report.stages) {
    await cx.mutation(api.pipeline.addGateReport, { candidateId, stage: s.stage, passed: s.passed, reason: s.reason, report: JSON.stringify(s.detail ?? {}).slice(0, 20_000), durationMs: s.durationMs });
  }
  const curvesJson = JSON.stringify(report.curves ?? {});

  if (!report.passed) {
    const partial = report.metrics.wfPooledSharpe !== undefined ? 0.5 * report.metrics.wfPooledSharpe : undefined;
    // BOOK-GATE: an IV sleeve that failed standalone S5iv-DSR is the orthogonal
    // diversifier we want — route it through the same book-marginal gate.
    if (cfg.book.marginalGate && report.failedStage === "S5iv-stats" && (report.failedReason ?? "").startsWith("DSR") && report.portfolioOos && report.portfolioOos.ret.length >= 100) {
      try {
        const admitted = await bookGatePromote(cx, cand, candidateId, report, cfg, ppy, log);
        if (admitted) return { passed: true, composite: report.metrics.portOosSharpe };
      } catch (e) { log(`iv book-gate skipped: ${e instanceof Error ? e.message.slice(0, 100) : e}`); }
    }
    await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: report.failedStage, failedReason: report.failedReason, metrics: JSON.stringify(report.metrics), curves: curvesJson, composite: partial });
    await cx.mutation(api.pipeline.addLesson, { source: cand.source, candidateId, stage: report.failedStage, text: `IV FAILED ${report.failedStage}: "${cand.name}" — ${report.failedReason}` });
    log(`IV FAILED at ${report.failedStage}: ${report.failedReason}`);
    return { passed: false, stage: report.failedStage };
  }

  await cx.mutation(api.paper.ensureAccount, { candidateId, startEquity: cfg.paperStartEquity });
  await cx.mutation(api.candidates.updateStage, {
    id: candidateId, stage: "incubating",
    metrics: JSON.stringify(report.metrics), bestParams: JSON.stringify(report.bestParams ?? {}),
    curves: curvesJson, composite: report.metrics.composite ?? report.metrics.portOosSharpe, incubationStartedAt: Date.now(),
  });
  await cx.mutation(api.pipeline.addLesson, { source: cand.source, candidateId, text: `IV PASSED: "${cand.name}" options-IV timing sleeve (OOS Sharpe ${(report.metrics.portOosSharpe ?? 0).toFixed(2)}, dsr ${(report.metrics.dsr ?? 0).toFixed(2)}) -> 30-day paper incubation.` });
  log(`IV PASSED -> incubating (OOS Sharpe ${(report.metrics.portOosSharpe ?? 0).toFixed(2)})`);
  return { passed: true, composite: report.metrics.composite };
}

// ====================================================================
// ON-CHAIN candidate processing (on-chain valuation-timing sleeve).
// ====================================================================
async function processOcCandidate(
  cx: ConvexHttpClient,
  candidateId: Id<"candidates">,
  cand: { name: string; hypothesis: string; source: string; hash: string; familyHash: string },
  doc: OcSleeveDoc,
  cfg: AppConfig,
  sealTs: number,
  log: Log,
): Promise<ProcessResult> {
  await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "gauntlet" });
  const ppy = 365;
  const barsRaw = await loadBars(doc.symbol, "1d");
  if (!barsRaw) {
    await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: "S0-static", failedReason: "missing perp bars" });
    return { passed: false, stage: "S0-static" };
  }
  // attach on-chain features (BTC/ETH only); if none, the sleeve can't run.
  const bars = await attachOnchain(barsRaw, doc.symbol);
  const daily: OcDaily = buildOcDaily(bars, doc.signal);
  if (daily.t.length < 400) {
    await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: "S0-static", failedReason: `no on-chain coverage for ${doc.symbol} (${daily.t.length} usable days)` });
    return { passed: false, stage: "S0-static" };
  }
  const sealIdx = daily.t.findIndex((t) => t >= sealTs);
  const sl = <T>(a: T[]): T[] => sealIdx >= 0 ? a.slice(sealIdx) : [];
  const dailySealed: OcDaily | undefined = sealIdx >= 0 && daily.t.length - sealIdx > 60
    ? { t: sl(daily.t), ret: sl(daily.ret), feat: sl(daily.feat), funding: sl(daily.funding) }
    : undefined;

  const nTrials = await cx.query(api.candidates.familySeenCount, { familyHash: cand.familyHash });
  await cx.mutation(api.pipeline.bumpCounter, { key: "trials_total", by: 1 });

  const report = runGauntletOc({ doc, daily, dailySealed, sealTs, floors: cfg.floors, nTrialsTotal: Math.max(nTrials, 40), log });
  for (const s of report.stages) {
    await cx.mutation(api.pipeline.addGateReport, { candidateId, stage: s.stage, passed: s.passed, reason: s.reason, report: JSON.stringify(s.detail ?? {}).slice(0, 20_000), durationMs: s.durationMs });
  }
  const curvesJson = JSON.stringify(report.curves ?? {});

  if (!report.passed) {
    const partial = report.metrics.wfPooledSharpe !== undefined ? 0.5 * report.metrics.wfPooledSharpe : undefined;
    // BOOK-GATE: an on-chain sleeve that failed standalone S5oc-DSR is the
    // orthogonal diversifier we want — route it through the same book-marginal gate.
    if (cfg.book.marginalGate && report.failedStage === "S5oc-stats" && (report.failedReason ?? "").startsWith("DSR") && report.portfolioOos && report.portfolioOos.ret.length >= 100) {
      try {
        const admitted = await bookGatePromote(cx, cand, candidateId, report, cfg, ppy, log);
        if (admitted) return { passed: true, composite: report.metrics.portOosSharpe };
      } catch (e) { log(`oc book-gate skipped: ${e instanceof Error ? e.message.slice(0, 100) : e}`); }
    }
    await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: report.failedStage, failedReason: report.failedReason, metrics: JSON.stringify(report.metrics), curves: curvesJson, composite: partial });
    await cx.mutation(api.pipeline.addLesson, { source: cand.source, candidateId, stage: report.failedStage, text: `ONCHAIN FAILED ${report.failedStage}: "${cand.name}" — ${report.failedReason}` });
    log(`ONCHAIN FAILED at ${report.failedStage}: ${report.failedReason}`);
    return { passed: false, stage: report.failedStage };
  }

  await cx.mutation(api.paper.ensureAccount, { candidateId, startEquity: cfg.paperStartEquity });
  await cx.mutation(api.candidates.updateStage, {
    id: candidateId, stage: "incubating",
    metrics: JSON.stringify(report.metrics), bestParams: JSON.stringify(report.bestParams ?? {}),
    curves: curvesJson, composite: report.metrics.composite ?? report.metrics.portOosSharpe, incubationStartedAt: Date.now(),
  });
  await cx.mutation(api.pipeline.addLesson, { source: cand.source, candidateId, text: `ONCHAIN PASSED: "${cand.name}" on-chain valuation-timing sleeve (OOS Sharpe ${(report.metrics.portOosSharpe ?? 0).toFixed(2)}, dsr ${(report.metrics.dsr ?? 0).toFixed(2)}) -> 30-day paper incubation.` });
  log(`ONCHAIN PASSED -> incubating (OOS Sharpe ${(report.metrics.portOosSharpe ?? 0).toFixed(2)})`);
  return { passed: true, composite: report.metrics.composite };
}

// ====================================================================
// TREND-BETA candidate processing (risk-managed long-beta sleeve). Single-coin
// daily stream -> adapted trend gauntlet (S4 cross-symbol skipped). Same floors +
// same validated DSR/bootstrap math. Promotion routes through the book/forward-
// paper gate, like the other orthogonal sleeves.
// ====================================================================
async function processTrendCandidate(
  cx: ConvexHttpClient,
  candidateId: Id<"candidates">,
  cand: { name: string; hypothesis: string; source: string; hash: string; familyHash: string },
  doc: TrendBetaDoc,
  cfg: AppConfig,
  sealTs: number,
  log: Log,
): Promise<ProcessResult> {
  await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "gauntlet" });
  const ppy = 365;
  const bars = await loadBars(doc.symbol, "1d");
  if (!bars) {
    await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: "S0-static", failedReason: "missing perp bars" });
    return { passed: false, stage: "S0-static" };
  }
  const daily: TrendDaily = buildTrendDaily(bars);
  if (daily.t.length < 400) {
    await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: "S0-static", failedReason: `not enough daily bars for ${doc.symbol}` });
    return { passed: false, stage: "S0-static" };
  }
  const sealIdx = daily.t.findIndex((t) => t >= sealTs);
  const sl = <T>(a: T[]): T[] => sealIdx >= 0 ? a.slice(sealIdx) : [];
  const dailySealed: TrendDaily | undefined = sealIdx >= 0 && daily.t.length - sealIdx > 60
    ? { t: sl(daily.t), ret: sl(daily.ret), close: sl(daily.close), funding: sl(daily.funding) }
    : undefined;

  const nTrials = await cx.query(api.candidates.familySeenCount, { familyHash: cand.familyHash });
  await cx.mutation(api.pipeline.bumpCounter, { key: "trials_total", by: 1 });

  const report = runGauntletTrend({ doc, daily, dailySealed, sealTs, floors: cfg.floors, nTrialsTotal: Math.max(nTrials, 40), log });
  for (const s of report.stages) {
    await cx.mutation(api.pipeline.addGateReport, { candidateId, stage: s.stage, passed: s.passed, reason: s.reason, report: JSON.stringify(s.detail ?? {}).slice(0, 20_000), durationMs: s.durationMs });
  }
  const curvesJson = JSON.stringify(report.curves ?? {});

  if (!report.passed) {
    const partial = report.metrics.wfPooledSharpe !== undefined ? 0.5 * report.metrics.wfPooledSharpe : undefined;
    // BOOK/FORWARD-PAPER GATE: a trend-beta sleeve that failed standalone S5tb-DSR
    // is exactly the risk-managed-beta we want forward-tested — route it through
    // the same book-marginal / forward-paper gate.
    if (cfg.book.marginalGate && report.failedStage === "S5tb-stats" && (report.failedReason ?? "").startsWith("DSR") && report.portfolioOos && report.portfolioOos.ret.length >= 100) {
      try {
        const admitted = await bookGatePromote(cx, cand, candidateId, report, cfg, ppy, log);
        if (admitted) return { passed: true, composite: report.metrics.portOosSharpe };
      } catch (e) { log(`trend book-gate skipped: ${e instanceof Error ? e.message.slice(0, 100) : e}`); }
    }
    await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: report.failedStage, failedReason: report.failedReason, metrics: JSON.stringify(report.metrics), curves: curvesJson, composite: partial });
    await cx.mutation(api.pipeline.addLesson, { source: cand.source, candidateId, stage: report.failedStage, text: `TRENDBETA FAILED ${report.failedStage}: "${cand.name}" — ${report.failedReason}` });
    log(`TRENDBETA FAILED at ${report.failedStage}: ${report.failedReason}`);
    return { passed: false, stage: report.failedStage };
  }

  await cx.mutation(api.paper.ensureAccount, { candidateId, startEquity: cfg.paperStartEquity });
  await cx.mutation(api.candidates.updateStage, {
    id: candidateId, stage: "incubating",
    metrics: JSON.stringify(report.metrics), bestParams: JSON.stringify(report.bestParams ?? {}),
    curves: curvesJson, composite: report.metrics.composite ?? report.metrics.portOosSharpe, incubationStartedAt: Date.now(),
  });
  await cx.mutation(api.pipeline.addLesson, { source: cand.source, candidateId, text: `TRENDBETA PASSED: "${cand.name}" risk-managed-beta sleeve (OOS Sharpe ${(report.metrics.portOosSharpe ?? 0).toFixed(2)}, dsr ${(report.metrics.dsr ?? 0).toFixed(2)}) -> 30-day paper incubation.` });
  log(`TRENDBETA PASSED -> incubating (OOS Sharpe ${(report.metrics.portOosSharpe ?? 0).toFixed(2)})`);
  return { passed: true, composite: report.metrics.composite };
}

// ====================================================================
// COMBINATION candidate processing (portfolio / overlay of chop-trend blocks). Loads
// 1d bars for each block coin, splits dev/sealed at the seal date, runs the combined
// gauntlet (the COMBINED OOS stream through the SAME floors + DSR/bootstrap math),
// and routes through the book/forward-paper gate on a DSR fail — exactly like the
// other sleeve families. The gauntlet/validation math is UNCHANGED.
// ====================================================================
async function processCombinationCandidate(
  cx: ConvexHttpClient,
  candidateId: Id<"candidates">,
  cand: { name: string; hypothesis: string; source: string; hash: string; familyHash: string },
  doc: CombinationDoc,
  cfg: AppConfig,
  sealTs: number,
  log: Log,
): Promise<ProcessResult> {
  await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "gauntlet" });
  const ppy = 365;
  // load 1d bars per distinct block coin; split dev (pre-seal) / sealed (post-seal).
  const symbols = [...new Set(doc.blocks.map((b) => b.symbol))];
  const barsBySym = new Map<string, Bars>();
  const sealedBySym = new Map<string, Bars>();
  for (const sym of symbols) {
    const bars = await loadBars(sym, "1d");
    if (!bars || bars.t.length < 600) {
      await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: "S0-static", failedReason: `missing/short bars for ${sym}` });
      return { passed: false, stage: "S0-static" };
    }
    const sealIdx = bars.t.findIndex((t) => t >= sealTs);
    const slice = (a: Bars, lo: number, hi: number): Bars => ({ symbol: a.symbol, tf: a.tf, t: a.t.slice(lo, hi), o: a.o.slice(lo, hi), h: a.h.slice(lo, hi), l: a.l.slice(lo, hi), c: a.c.slice(lo, hi), v: a.v.slice(lo, hi), fundingT: a.fundingT, fundingR: a.fundingR });
    if (sealIdx >= 0) {
      barsBySym.set(sym, slice(bars, 0, sealIdx));
      if (bars.t.length - sealIdx > 60) sealedBySym.set(sym, slice(bars, sealIdx, bars.t.length));
    } else {
      barsBySym.set(sym, bars);
    }
  }

  const nTrials = await cx.query(api.candidates.familySeenCount, { familyHash: cand.familyHash });
  await cx.mutation(api.pipeline.bumpCounter, { key: "trials_total", by: 1 });

  const report = runGauntletCombination({ doc, barsBySym, sealedBySym: sealedBySym.size ? sealedBySym : undefined, sealTs, floors: cfg.floors, nTrialsTotal: Math.max(nTrials, 40), log });
  for (const s of report.stages) {
    await cx.mutation(api.pipeline.addGateReport, { candidateId, stage: s.stage, passed: s.passed, reason: s.reason, report: JSON.stringify(s.detail ?? {}).slice(0, 20_000), durationMs: s.durationMs });
  }
  const curvesJson = JSON.stringify(report.curves ?? {});

  if (!report.passed) {
    const partial = report.metrics.wfPooledSharpe !== undefined ? 0.5 * report.metrics.wfPooledSharpe : undefined;
    // BOOK/FORWARD-PAPER GATE: a combination that failed standalone S5cb-DSR but has a
    // genuinely risk-improving combined stream is exactly what we want forward-tested.
    if (cfg.book.marginalGate && report.failedStage === "S5cb-stats" && (report.failedReason ?? "").startsWith("DSR") && report.portfolioOos && report.portfolioOos.ret.length >= 100) {
      try {
        const admitted = await bookGatePromote(cx, cand, candidateId, report, cfg, ppy, log);
        if (admitted) return { passed: true, composite: report.metrics.portOosSharpe };
      } catch (e) { log(`combination book-gate skipped: ${e instanceof Error ? e.message.slice(0, 100) : e}`); }
    }
    await cx.mutation(api.candidates.updateStage, { id: candidateId, stage: "failed", failedStage: report.failedStage, failedReason: report.failedReason, metrics: JSON.stringify(report.metrics), curves: curvesJson, composite: partial });
    await cx.mutation(api.pipeline.addLesson, { source: cand.source, candidateId, stage: report.failedStage, text: `COMBINATION FAILED ${report.failedStage}: "${cand.name}" (${doc.mode}, ${doc.blocks.length} blocks) — ${report.failedReason}` });
    log(`COMBINATION FAILED at ${report.failedStage}: ${report.failedReason}`);
    return { passed: false, stage: report.failedStage };
  }

  await cx.mutation(api.paper.ensureAccount, { candidateId, startEquity: cfg.paperStartEquity });
  await cx.mutation(api.candidates.updateStage, {
    id: candidateId, stage: "incubating",
    metrics: JSON.stringify(report.metrics), bestParams: JSON.stringify(report.bestParams ?? {}),
    curves: curvesJson, composite: report.metrics.composite ?? report.metrics.portOosSharpe, incubationStartedAt: Date.now(),
  });
  await cx.mutation(api.pipeline.addLesson, { source: cand.source, candidateId, text: `COMBINATION PASSED: "${cand.name}" (${doc.mode}, ${doc.blocks.length} blocks, ${doc.alloc}) combined OOS Sharpe ${(report.metrics.portOosSharpe ?? 0).toFixed(2)}, dsr ${(report.metrics.dsr ?? 0).toFixed(2)} -> 30-day paper incubation.` });
  log(`COMBINATION PASSED -> incubating (combined OOS Sharpe ${(report.metrics.portOosSharpe ?? 0).toFixed(2)})`);
  return { passed: true, composite: report.metrics.composite };
}
