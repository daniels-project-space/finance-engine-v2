// LLM ideation layer. Primary: Claude Fable 5 (Anthropic SDK, structured
// output via output_config JSON schema). Fallback: DeepSeek via OpenRouter
// (provider-pinned — SiliconFlow fp8 corrupts JSON). Both produce StrategyDoc
// proposals validated by the DSL before they touch the pipeline.
// Budget enforcement (USD/day) is the caller's job via the Convex counters.

import Anthropic from "@anthropic-ai/sdk";
import { validateStrategy } from "./dsl";
import type { StrategyDoc } from "./types";

export interface LlmProposal {
  doc: StrategyDoc;
  rationale: string;
}

export interface LlmUsage {
  provider: "anthropic" | "openrouter";
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const FABLE_IN_PER_M = 10, FABLE_OUT_PER_M = 50;

const DSL_GUIDE = `You design crypto perp trading strategies as JSON expression graphs ("DSL"). NO code — pure JSON.

Expr grammar (recursive):
 {"op":"price","field":"open|high|low|close|volume"}
 {"op":"const","value":number}
 {"op":"param","name":string}                          // tunable; declare in params
 {"op":IND,"src":Expr,"period":Expr}                    // IND: ema sma wma rsi atr stdev highest lowest lag zscore slope pctrank median roc; period must be const or param
 {"op":"add|sub|mul|div|min2|max2","a":Expr,"b":Expr}
 {"op":"abs|neg|log|sign|sqrt","a":Expr}
 {"op":"gt|lt|crossover|crossunder","a":Expr,"b":Expr}  // -> boolean
 {"op":"and|or","a":Expr,"b":Expr} {"op":"not","a":Expr}

Strategy object:
 {"name":str,"hypothesis":str (WHY it should work, mechanism not vibes),
  "longEntry":BoolExpr,"longExit":BoolExpr,"shortEntry?":BoolExpr,"shortExit?":BoolExpr,
  "params":{name:{min,max,default,int?}}, // <=6 params
  "risk":{"stopAtrMult?":num,"trailAtrMult?":num,"volTargetAnnual":0.25,"maxLeverage":2}}

Constraints: <=48 nodes per expression, depth <=10, periods 1..500. Strategies trade 1h bars on BTC/ETH/SOL/BNB/XRP USDT perps, costs ~7bps/side + funding. They must survive: re-tuning walk-forward (OOS Sharpe>0.5, 55% positive months), cross-symbol generalization (3/5 pairs), DSR>0.95 deflated for all trials ever, permutation test p<0.05, 3x slippage, crisis replays, then a sealed holdout and 30 days of live paper. Design for robustness, not in-sample fit: prefer structural/regime-aware mechanisms, few params, slow signals over fast noise. Aim 30-300 trades/yr.`;

const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rationale: { type: "string" },
          strategy: { type: "object", additionalProperties: true },
        },
        required: ["rationale", "strategy"],
        additionalProperties: false,
      },
    },
  },
  required: ["proposals"],
  additionalProperties: false,
} as const;

export function buildPrompt(lessons: string[], marketNotes: string, nProposals: number, championSummary: string): string {
  return `${DSL_GUIDE}

## Current champion
${championSummary || "none yet"}

## Journal of recent lessons (what failed/succeeded and why — do NOT repeat failures)
${lessons.length ? lessons.map((l) => `- ${l}`).join("\n") : "- (no lessons yet)"}

## Market notes
${marketNotes || "(none)"}

Propose ${nProposals} DIVERSE strategies (different mechanism families — don't submit ${nProposals} variations of one idea). Each must include a falsifiable hypothesis naming the structural reason the edge exists (who is on the other side / what friction creates it).`;
}

export function parseProposals(raw: string): LlmProposal[] {
  let parsed: unknown;
  const cleaned = raw.replace(/```json\s*/g, "").replace(/```/g, "");
  try { parsed = JSON.parse(cleaned); } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try { parsed = JSON.parse(m[0]); } catch { return []; }
  }
  // accept several reasonable envelopes: {proposals:[{rationale,strategy}]},
  // {strategies:[StrategyDoc]}, or a bare top-level array of either shape
  const env = parsed as { proposals?: unknown[]; strategies?: unknown[] };
  const arr = env?.proposals ?? env?.strategies ?? (Array.isArray(parsed) ? parsed : undefined);
  if (!Array.isArray(arr)) return [];
  const out: LlmProposal[] = [];
  for (const item of arr) {
    const it = item as { rationale?: string; strategy?: StrategyDoc } & Partial<StrategyDoc>;
    const doc = (it?.strategy ?? (it?.longEntry ? (it as unknown as StrategyDoc) : undefined)) as StrategyDoc | undefined;
    if (!doc) continue;
    doc.risk = doc.risk ?? { volTargetAnnual: 0.25, maxLeverage: 2 };
    doc.risk.volTargetAnnual = doc.risk.volTargetAnnual || 0.25;
    doc.risk.maxLeverage = Math.min(doc.risk.maxLeverage || 2, 2);
    doc.params = doc.params ?? {};
    if (validateStrategy(doc).length === 0) out.push({ doc, rationale: it.rationale ?? "" });
  }
  return out;
}

export async function proposeWithFable(
  apiKey: string,
  lessons: string[],
  marketNotes: string,
  championSummary: string,
  nProposals = 4,
): Promise<{ proposals: LlmProposal[]; usage: LlmUsage }> {
  const client = new Anthropic({ apiKey });
  const raw = await client.messages.create({
    model: "claude-fable-5",
    max_tokens: 16000,
    output_config: { effort: "medium", format: { type: "json_schema", schema: PROPOSAL_SCHEMA } },
    messages: [{ role: "user", content: buildPrompt(lessons, marketNotes, nProposals, championSummary) }],
  } as unknown as Parameters<typeof client.messages.create>[0]);
  const resp = raw as unknown as {
    stop_reason?: string;
    content: { type: string; text?: string }[];
    usage: { input_tokens: number; output_tokens: number };
  };

  if (resp.stop_reason === "refusal") {
    throw new Error("fable refusal");
  }
  const text = resp.content.find((b) => b.type === "text")?.text ?? "";
  const usage = resp.usage;
  return {
    proposals: parseProposals(text),
    usage: {
      provider: "anthropic", model: "claude-fable-5",
      inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      costUsd: (usage.input_tokens * FABLE_IN_PER_M + usage.output_tokens * FABLE_OUT_PER_M) / 1_000_000,
    },
  };
}

export async function proposeWithDeepSeek(
  apiKey: string,
  lessons: string[],
  marketNotes: string,
  championSummary: string,
  nProposals = 4,
): Promise<{ proposals: LlmProposal[]; usage: LlmUsage }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 150_000); // ideation must never block the GP flywheel
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: ctrl.signal,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek/deepseek-chat",
      // prefer first-party hosts; fall back to whatever is live (every proposal
      // is schema-validated downstream, so a corrupt-JSON host just yields 0)
      provider: { order: ["deepseek", "alibaba", "deepinfra", "novita"], allow_fallbacks: true },
      max_tokens: 6000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Output ONLY a JSON object {\"proposals\":[{\"rationale\":str,\"strategy\":{...}}]}. No prose." },
        { role: "user", content: buildPrompt(lessons, marketNotes, nProposals, championSummary) },
      ],
    }),
  });
  clearTimeout(timer);
  if (!resp.ok) throw new Error(`openrouter ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json() as { choices: { message: { content: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
  const text = data.choices?.[0]?.message?.content ?? "";
  return {
    proposals: parseProposals(text),
    usage: {
      provider: "openrouter", model: "deepseek/deepseek-chat",
      inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0,
      costUsd: ((data.usage?.prompt_tokens ?? 0) * 0.3 + (data.usage?.completion_tokens ?? 0) * 1.2) / 1_000_000,
    },
  };
}

/** Fable first; on credit/availability/refusal errors fall back to DeepSeek. */
export async function propose(
  keys: { anthropic?: string; openrouter?: string },
  budgetLeftUsd: number,
  lessons: string[],
  marketNotes: string,
  championSummary: string,
  nProposals = 4,
): Promise<{ proposals: LlmProposal[]; usage: LlmUsage } | { proposals: []; usage: null; skipped: string }> {
  if (keys.anthropic && budgetLeftUsd > 0.3) {
    try {
      return await proposeWithFable(keys.anthropic, lessons, marketNotes, championSummary, nProposals);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`fable failed (${msg.slice(0, 120)}), falling back to deepseek`);
    }
  }
  if (keys.openrouter) {
    try {
      return await proposeWithDeepSeek(keys.openrouter, lessons, marketNotes, championSummary, nProposals);
    } catch (err) {
      console.warn(`deepseek failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { proposals: [], usage: null, skipped: "no working LLM provider (GP continues regardless)" };
}
