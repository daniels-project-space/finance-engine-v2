// LLM HYPOTHESIS-AND-ITERATION loop — automate Daniel's propose -> diagnose -> fix.
//
// The engine one-shots: it proposes a strategy, the gauntlet kills it, and the
// failure is pooled into a 25-line "recentLessons" blob that the NEXT, unrelated
// proposal sees. Daniel does the opposite: he proposes ONE strategy, watches HOW it
// fails (chop gate -> whipsaw -> add 200MA confirm -> drawdown -> add overlay), and
// fixes THAT specific failure, keeping the lineage. This module makes the engine
// iterate the same way.
//
// It is PURE orchestration on top of the existing LLM + gauntlet:
//   - buildFailureReport: turns a candidate's OWN GauntletReport into a structured
//     per-candidate diagnosis (which STAGE killed it, the killing metric + value,
//     the months/regime/symbol that broke it, an equity-curve summary).
//   - buildFixPrompt: asks the LLM for a TARGETED fix to THAT failure, carrying the
//     lineage scratchpad (what was tried, what each round did).
//   - runFixRound: one LLM call (subscription CLI -> DeepSeek fallback) that returns
//     the fixed StrategyDoc + rationale.
// The CALLER (process.ts) drives the loop: it gauntlets each round with the REAL
// gauntlet, feeds the report back here, caps rounds + token budget, keeps the best.
// NO gauntlet/validation math here — generation/orchestration only.

import { runClaudeCli, parseProposals, DSL_GUIDE, type LlmProposal, type LlmUsage } from "./llm";
import { EVOLUTION_MODEL, priceFor } from "./model";
import type { StrategyDoc } from "./types";

/** The DSL guide (re-exported from llm.ts) the fix prompt prepends. */
export const ITERATE_DSL_GUIDE = DSL_GUIDE;

// the slice of a GauntletReport this module reads (kept narrow so it doesn't import
// the gauntlet types; the caller passes the fields verbatim).
export interface ReportLike {
  passed: boolean;
  failedStage?: string;
  failedReason?: string;
  stages: { stage: string; passed: boolean; reason?: string }[];
  metrics: {
    trainSharpe?: number; wfPooledSharpe?: number; wfPctPositive?: number; wfWorstMonth?: number; wfMaxDD?: number;
    fullSharpe?: number; fullMaxDD?: number; winRate?: number; fullTrades?: number; exposure?: number;
    dsr?: number; permutationP?: number; bootstrapP5?: number; crossSymbolPositive?: number;
    portOosSharpe?: number; portPctPositive?: number; portMaxDD?: number; composite?: number;
    regimeSharpes?: Record<string, number>; regimeMinSharpe?: number; pnlConcentration?: boolean;
  };
  curves?: { wf?: { t: number[]; eq: number[] }; port?: { t: number[]; eq: number[] } };
}

const pctS = (x: number | undefined, d = 0) => x === undefined ? "n/a" : `${(x * 100).toFixed(d)}%`;
const numS = (x: number | undefined, d = 2) => x === undefined ? "n/a" : x.toFixed(d);

// plain-English description of WHY each stage kills + what a fix usually looks like.
const STAGE_GUIDE: Record<string, string> = {
  "S2-train": "It couldn't even fit the training window (too few trades, weak in-sample Sharpe, or a busted drawdown). The signal is too weak or too rarely active. Strengthen/loosen the entry, or fix the risk sizing.",
  "S3-walkforward": "It fit the train window but FELL APART out-of-sample (re-tuned per window). Classic overfit / whipsaw: it traded noise. Add a regime/chop filter so it only acts when the edge is real; slow the signal; require confirmation.",
  "S4-cross-symbol": "It worked on the evolution symbol but did NOT generalize across the other coins — single-symbol overfit. Make the mechanism structural (regime/volatility-relative, not a magic constant tuned to one coin).",
  "S5-stats": "It passed walk-forward but FAILED the statistical bar — DSR (deflated for all trials) too low, or the bootstrap CI of its Sharpe includes zero, or permutation p too high. The edge isn't distinguishable from luck after multiple-testing deflation. Make the edge BIGGER/more consistent (fewer, higher-conviction trades) or more robust — small Sharpe over many trials won't clear DSR.",
  "S5b-stress": "It died under cost/slippage or crisis-regime stress. The edge is too thin to survive 3x slippage or it concentrates in one fragile regime. Cut turnover, widen the edge per trade, or add a crisis guard.",
  "S5c-pbo": "High probability of backtest overfitting (PBO) across the tuner's configs — the in-sample-best config doesn't stay best out-of-sample. Fewer params, a flatter/plateau-robust design.",
  "S6-sealed": "It cleared everything but FAILED on the untouched sealed holdout (or made <=0 there) — the most honest test. It overfit the dev window. Make it simpler and more structural.",
};
// the sleeve-adapter stage variants map to the same guidance
function stageKey(stage: string): string {
  const s = stage || "";
  if (/^S2/.test(s)) return "S2-train";
  if (/walkforward|^S3/.test(s)) return "S3-walkforward";
  if (/cross-symbol|^S4/.test(s)) return "S4-cross-symbol";
  if (/^S5c|pbo/.test(s)) return "S5c-pbo";
  if (/^S5b|stress/.test(s)) return "S5b-stress";
  if (/^S5|stats|dsr/.test(s)) return "S5-stats";
  if (/sealed|^S6/.test(s)) return "S6-sealed";
  return "S3-walkforward";
}

/** Summarize an equity curve: the worst peak-to-trough window (when the strategy
 *  bled), so the prompt can point at the period that broke it. */
function curveSummary(curve?: { t: number[]; eq: number[] }): string {
  if (!curve?.eq?.length || curve.eq.length < 5) return "";
  const { t, eq } = curve;
  let peak = eq[0], peakI = 0, worstDD = 0, troughI = 0, ddPeakI = 0;
  for (let i = 0; i < eq.length; i++) {
    if (eq[i] > peak) { peak = eq[i]; peakI = i; }
    const dd = eq[i] / peak - 1;
    if (dd < worstDD) { worstDD = dd; troughI = i; ddPeakI = peakI; }
  }
  const fmt = (ts: number) => ts ? new Date(ts).toISOString().slice(0, 7) : "?";
  if (worstDD >= -0.02) return `Equity rose fairly steadily (worst dip ${pctS(worstDD)}).`;
  return `Worst drawdown ${pctS(worstDD)} from ${fmt(t[ddPeakI])} to ${fmt(t[troughI])} — the strategy bled hardest in that window; look at what regime that was (chop? a sharp reversal? a downtrend?).`;
}

/**
 * Build the STRUCTURED per-candidate failure report from its OWN GauntletReport.
 * This is the diagnosis the next round reasons from — NOT pooled lessons.
 */
export function buildFailureReport(doc: StrategyDoc, report: ReportLike): string {
  const m = report.metrics;
  const reached = report.stages.filter((s) => s.passed).map((s) => s.stage);
  const stage = report.failedStage ?? "unknown";
  const guide = STAGE_GUIDE[stageKey(stage)] ?? "";
  const lines: string[] = [];
  lines.push(`DIED AT: ${stage}`);
  lines.push(`KILLING REASON: ${report.failedReason ?? "(none)"}`);
  if (reached.length) lines.push(`Stages it PASSED first: ${reached.join(" → ")}`);
  lines.push(`What ${stage} means + the usual fix: ${guide}`);
  // the killing metric in context
  const metricBits: string[] = [];
  if (m.trainSharpe !== undefined) metricBits.push(`train Sharpe ${numS(m.trainSharpe)}`);
  if (m.wfPooledSharpe !== undefined) metricBits.push(`walk-forward OOS Sharpe ${numS(m.wfPooledSharpe)} (need ≥0.5)`);
  if (m.wfPctPositive !== undefined) metricBits.push(`${pctS(m.wfPctPositive)} positive months (need ≥55%)`);
  if (m.wfMaxDD !== undefined) metricBits.push(`OOS maxDD ${pctS(m.wfMaxDD)}`);
  if (m.crossSymbolPositive !== undefined) metricBits.push(`positive on ${m.crossSymbolPositive}/5 coins (need ≥3)`);
  if (m.dsr !== undefined) metricBits.push(`DSR ${numS(m.dsr, 3)} (need ≥0.95 — deflated for all trials)`);
  if (m.bootstrapP5 !== undefined) metricBits.push(`bootstrap Sharpe 5th-pct ${numS(m.bootstrapP5)}`);
  if (m.permutationP !== undefined) metricBits.push(`permutation p ${numS(m.permutationP, 3)} (need <0.05)`);
  if (m.fullTrades !== undefined) metricBits.push(`${m.fullTrades} trades`);
  if (m.winRate !== undefined) metricBits.push(`win rate ${pctS(m.winRate)}`);
  if (metricBits.length) lines.push(`Measured: ${metricBits.join(", ")}.`);
  // regime / concentration diagnosis
  if (m.regimeSharpes && Object.keys(m.regimeSharpes).length) {
    const rs = Object.entries(m.regimeSharpes).map(([r, s]) => `${r}:${numS(s)}`).join(", ");
    lines.push(`Per-regime OOS Sharpe: ${rs}.${m.regimeMinSharpe !== undefined ? ` Weakest regime Sharpe ${numS(m.regimeMinSharpe)}.` : ""}`);
  }
  if (m.pnlConcentration) lines.push(`WARNING: >80% of profit came from ONE regime — fragile, regime-dependent. Make it work across regimes or gate to the regime it actually likes.`);
  // equity-curve summary (when/where it bled)
  const cs = curveSummary(report.curves?.wf ?? report.curves?.port);
  if (cs) lines.push(`Equity path: ${cs}`);
  // the strategy itself (so the LLM sees what to fix)
  lines.push(`The strategy that failed (fix THIS, keep what works):\n${JSON.stringify({ name: doc.name, hypothesis: doc.hypothesis, tf: doc.tf, longEntry: doc.longEntry, longExit: doc.longExit, shortEntry: doc.shortEntry, shortExit: doc.shortExit, params: doc.params, risk: doc.risk })}`);
  return lines.join("\n");
}

/** One entry in a lineage scratchpad — what a round produced + how it did. */
export interface LineageEntry { round: number; name: string; rationale: string; failedStage?: string; oosSharpe?: number; dsr?: number; passed: boolean }

/**
 * Build the TARGETED-FIX prompt: the DSL guide + the structured failure report +
 * the lineage scratchpad. Asks for ONE fixed strategy that addresses THIS specific
 * failure, not a fresh idea.
 */
export function buildFixPrompt(dslGuide: string, failureReport: string, lineage: LineageEntry[], round: number, maxRounds: number): string {
  const history = lineage.length
    ? `\nLINEAGE SO FAR (what's already been tried in this iteration — do NOT repeat a fix that already failed):\n${lineage.map((e) => `  round ${e.round}: "${e.name}" → ${e.passed ? "PASSED" : `died at ${e.failedStage}`} (OOS Sharpe ${numS(e.oosSharpe)}, DSR ${numS(e.dsr, 2)}); ${e.rationale.slice(0, 120)}`).join("\n")}\n`
    : "";
  return `${dslGuide}

You are iterating on ONE strategy lineage like a quant researcher — propose, see HOW it failed, fix THAT specific failure, repeat. This is round ${round} of ${maxRounds}.

THE CANDIDATE'S OWN FAILURE REPORT (diagnose from THIS, not generic advice):
${failureReport}
${history}
Propose ONE targeted FIX. Keep the parts of the mechanism that worked (it passed earlier stages); change ONLY what's needed to fix the stage it died at. Reason explicitly: name the failure mode (e.g. "it whipsawed in 2023 chop"), the mechanism fix (e.g. "add a choppiness<50 gate so it sits out sideways markets"), and why that addresses THE measured killer. SIMPLE, structural fixes beat adding params. If the failure is DSR/significance, the edge per trade is too thin — make it bigger/rarer, don't add complexity.

Output ONLY a JSON object {"proposals":[{"rationale":str,"strategy":{...}}]} with EXACTLY ONE proposal (the fix). No prose, no markdown fences.`;
}

/** Run ONE fix round through the subscription CLI (→ DeepSeek fallback handled by
 *  the caller). Returns the single fixed proposal + usage, or null if no valid doc. */
export async function runFixRound(prompt: string, model = EVOLUTION_MODEL): Promise<{ proposal: LlmProposal | null; usage: LlmUsage }> {
  const { text, inputTokens, outputTokens } = await runClaudeCli(prompt, model);
  const proposals = parseProposals(text);
  const price = priceFor(model);
  return {
    proposal: proposals[0] ?? null,
    usage: { provider: "anthropic-cli", model, inputTokens, outputTokens, costUsd: (inputTokens * price.in + outputTokens * price.out) / 1_000_000 },
  };
}

