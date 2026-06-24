// Shared pipeline logic — the SAME code runs in Trigger.dev tasks and in
// local/manual kickoff scripts, so cloud and manual cycles are identical.

import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { mergeConfig, todayKey, type AppConfig } from "../lib/appConfig";
import { loadBars } from "../lib/data";
import { artifactKey, putJsonGz, getJsonGz } from "../lib/storage";
import { canonicalHash, familyHash, validateStrategy } from "../engine/dsl";
import { crossoverStrategies, mutateStrategy, randomStrategy, recipeOf, setIcBias, MUTATION_OPS, type MutationHint, type MutationOp } from "../engine/evolve";
import { icFamilyWeights, icRankingText, type IcRankedRow } from "../engine/signals";
import { SEED_LIBRARY } from "../engine/library";
import { IMPORTED_LIBRARY } from "../engine/imports";
import { evaluateSealed, runGauntlet, runGauntletXSection, runGauntletIv, type GauntletReport } from "../engine/gauntlet";
import { isXSection, alignUniverse, type XSectionDoc, type XAligned } from "../engine/xsection";
import { generateXSection, validateXSection, xsectionHash, xsectionFamilyHash } from "../engine/xsectionGen";
import { isIvSleeve, buildIvDaily, type IvSleeveDoc, type IvDaily } from "../engine/ivsleeve";
import { generateIvSleeve, validateIvSleeve, ivSleeveHash, ivSleeveFamilyHash } from "../engine/ivsleeveGen";
import { loadDvol, dvolMap, dvolCurrencyFor } from "../lib/deribit";
import { realityCheck } from "../engine/rigor";
import { buildBook, marginalContribution, bookQualifies, type Stream } from "../engine/book";
import { perSleeveSignificant, marginalAdmits, bookLevelGate } from "../engine/bookGate";
import { propose } from "../engine/llm";
import { premiumOf } from "../engine/premia";
import { setBayesTuning } from "../engine/tune";
import { thompsonPick, antiThompsonPick, type Arm } from "../engine/bandit";
import { mulberry32 } from "../engine/stats";
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
  const recipeArms: Arm[] = MUTATION_OPS.map((op) => {
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
  type Proposal = { doc: StrategyDoc | XSectionDoc | IvSleeveDoc; source: string; parentIds?: string[]; mechanism?: string; parentComposite?: number; expectedComposite?: number; wild?: boolean };
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
  for (let i = 0; i < gpN && parents.length > 0; i++) {
    const seed = seedBase + i;
    if (parents.length >= 2 && i % 4 === 3) {
      const a = pickParent(), b = pickParent();
      proposals.push({
        doc: crossoverStrategies(a.doc, b.doc, seed), source: "crossover", parentIds: [a.id, b.id],
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
      const { doc, mutation } = mutateStrategy(p.doc, seed, p.hint, { forcedOp });
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
  for (let i = 0; i < freshN; i++) {
    proposals.push({ doc: randomStrategy(seedBase + 100_000 + i), source: "gp", mechanism: "fresh", expectedComposite: globalMean, wild: false });
    summary.fresh++;
  }

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
      { allowClaudeCli: allowCli, anchored: cfg.generation.premiumAnchoredGen, icRanking },
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
  const rawDoc = JSON.parse(cand.dsl) as StrategyDoc | XSectionDoc | IvSleeveDoc;
  const sealTs = Date.parse(cfg.sealDate);

  // CROSS-SECTIONAL routing: an xsection sleeve takes the adapted gauntlet path
  // (S4 cross-symbol skipped; honesty tests on the single universe-wide stream).
  if (isXSection(rawDoc)) {
    return processXSectionCandidate(cx, candidateId, cand, rawDoc, cfg, sealTs, log);
  }
  // IV-TIMING routing: a single-coin options-IV perp-timing sleeve -> IV gauntlet.
  if (isIvSleeve(rawDoc)) {
    return processIvCandidate(cx, candidateId, cand, rawDoc, cfg, sealTs, log);
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
  const primary = await loadBars(cfg.primarySymbol, tf);
  if (!primary || primary.t.length < ppy * 2.2) throw new Error(`primary ${tf} bars missing/short — run ingest first`);
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
  if (!C.passes) return false;

  // ---- ADMIT: persist the enlarged book + route to paper incubation ----------
  const newAdmitted: AdmittedSleeve[] = [...admitted, { id: candidateId as string, name: cand.name, t: oos.t, ret: oos.ret }];
  await putJsonGz(ADMITTED_BOOK_KEY, newAdmitted);
  const metrics = { ...report.metrics, bookAdmitted: 1, bookSharpe: C.bookSharpe, bookDeflated: C.bookDeflatedSharpe, bookDivRatio: C.diversificationRatio, marginalBookSharpe: B.marginal.marginalSharpe, maxBookCorr: B.marginal.maxCorr };
  await cx.mutation(api.paper.ensureAccount, { candidateId, startEquity: cfg.paperStartEquity });
  await cx.mutation(api.candidates.updateStage, {
    id: candidateId, stage: "incubating",
    metrics: JSON.stringify(metrics), bestParams: JSON.stringify(report.bestParams ?? {}),
    curves: JSON.stringify(report.curves ?? {}),
    composite: report.metrics.portOosSharpe, incubationStartedAt: Date.now(),
  });
  await cx.mutation(api.pipeline.addLesson, {
    source: cand.source, candidateId,
    text: `BOOK-ADMITTED: "${cand.name}" failed standalone S5-DSR but joined the diversified book (book Sharpe ${C.bookSharpe.toFixed(2)}, deflated ${C.bookDeflatedSharpe.toFixed(2)}, divRatio ${C.diversificationRatio.toFixed(2)}, ${C.nMembers} sleeves). Entered 30-day paper incubation as a book component.`,
  });
  log(`BOOK-ADMITTED -> incubating: "${cand.name}" (book now ${C.nMembers} sleeves, Sharpe ${C.bookSharpe.toFixed(2)})`);
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
