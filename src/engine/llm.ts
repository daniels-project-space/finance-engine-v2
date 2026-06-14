// LLM ideation layer.
//
// AUTH POLICY (hard rule): Anthropic ideation runs through the locally
// authenticated Claude Code CLI on Daniel's Max SUBSCRIPTION — `claude -p
// --model <id> --output-format json`, reading the OAuth credentials at
// ~/.claude/.credentials.json (auto-refreshed). There is NO @anthropic-ai/sdk
// / ANTHROPIC_API_KEY path anywhere: the loop must never bill console credits.
// This path runs BOTH on the VPS (local cron) AND in the Trigger.dev cloud
// worker: @anthropic-ai/claude-code is baked into the deploy image and authed
// from the injected CLAUDE_CODE_OAUTH_TOKEN. DeepSeek (OpenRouter) is the only
// fallback, used solely when the CLI errors — a NON-Anthropic backup, allowed.
//
// Both producers yield StrategyDoc proposals validated by the DSL before they
// touch the pipeline. Budget is the caller's job via the Convex counters; the
// subscription CLI is flat-rate, so its USD "cost" is a logged metric, not a
// charge.

import { execFile } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { validateStrategy } from "./dsl";
import { EVOLUTION_MODEL, priceFor } from "./model";
import type { StrategyDoc } from "./types";

const require = createRequire(import.meta.url);

export interface LlmProposal {
  doc: StrategyDoc;
  rationale: string;
}

export interface LlmUsage {
  provider: "anthropic-cli" | "openrouter";
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// How long to allow the (Opus) CLI call to run. Opus on a 1M-context ideation
// prompt at default effort can take minutes — generous so latency never aborts
// a valid call. Override with EVOLUTION_LLM_TIMEOUT_MS.
const CLI_TIMEOUT_MS = Number(process.env.EVOLUTION_LLM_TIMEOUT_MS ?? 12 * 60 * 1000);

const DSL_GUIDE = `You design crypto perp trading strategies as JSON expression graphs ("DSL"). NO code — pure JSON.

Expr grammar (recursive):
 {"op":"price","field":"open|high|low|close|volume"}
 {"op":"const","value":number}
 {"op":"param","name":string}                          // tunable; declare in params
 {"op":IND,"src":Expr,"period":Expr}                    // IND: ema sma wma rsi atr stdev highest lowest lag zscore slope pctrank median roc; period must be const or param
 {"op":"add|sub|mul|div|min2|max2","a":Expr,"b":Expr}
 {"op":"abs|neg|log|sign|sqrt","a":Expr}
 {"op":"hourutc"} {"op":"dowutc"}                        // UTC hour 0-23 / day-of-week 0=Sun..6 (seasonality)
 {"op":"gt|lt|crossover|crossunder","a":Expr,"b":Expr}  // -> boolean
 {"op":"and|or","a":Expr,"b":Expr} {"op":"not","a":Expr}

Strategy object:
 {"name":str,"hypothesis":str (WHY it should work, mechanism not vibes),
  "tf?":"1h"|"4h"|"1d",  // bar timeframe (default 1h); slower tf = scaled trade-count floors
  "longEntry":BoolExpr,"longExit":BoolExpr,"shortEntry?":BoolExpr,"shortExit?":BoolExpr,
  "params":{name:{min,max,default,int?}}, // <=6 params
  "risk":{"stopAtrMult?":num,"trailAtrMult?":num,"volTargetAnnual":0.1-0.6,"maxLeverage":1-4}}
Leverage appetite (volTargetAnnual + maxLeverage) is judged by the same drawdown floors — an account bust in backtest is terminal, so size deliberately.

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
    doc.risk.volTargetAnnual = Math.min(Math.max(doc.risk.volTargetAnnual || 0.25, 0.1), 0.6);
    doc.risk.maxLeverage = Math.min(doc.risk.maxLeverage || 2, 4);
    if (doc.tf !== undefined && !["1h", "4h", "1d"].includes(doc.tf)) delete (doc as { tf?: string }).tf;
    doc.params = doc.params ?? {};
    if (validateStrategy(doc).length === 0) out.push({ doc, rationale: it.rationale ?? "" });
  }
  return out;
}

// ---------------------------------------------------------------- Claude CLI
interface ClaudeCliJson {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Resolve the absolute path to the claude binary. In the Trigger cloud image the
 * package is installed into the image node_modules (additionalPackages) but the
 *  bin is NOT on PATH and the task cwd is the bundle dir — so we resolve
 * the package via createRequire and exec node_modules/.bin/claude by absolute
 * path. On the VPS (claude installed globally) none of those exist on disk, so we
 * fall back to CLAUDE_BIN or PATH `claude`. Works in both environments.
 */
function resolveClaudeBin(): string {
  try {
    const pkgJson = require.resolve("@anthropic-ai/claude-code/package.json");
    const pkgDir = dirname(pkgJson);                 // .../node_modules/@anthropic-ai/claude-code
    const nodeModules = dirname(dirname(pkgDir));    // .../node_modules
    const candidates = [join(nodeModules, ".bin", "claude")];
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { bin?: string | Record<string, string> };
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.claude;
      if (rel) candidates.push(join(pkgDir, rel));
    } catch { /* ignore malformed package.json */ }
    for (const c of candidates) if (existsSync(c)) return c;
  } catch { /* package not installed on disk (VPS global case) — fall through */ }
  return process.env.CLAUDE_BIN || "claude";
}

/**
 * Run the headless Claude Code CLI on the owner subscription. Returns the model
 * text + token usage. Throws on missing CLI, error result, or empty output —
 * the caller (propose) catches and falls back to DeepSeek. ANTHROPIC_API_KEY is
 * explicitly stripped from the child env so a stray key can never route this
 * through the billed API instead of the subscription. CLAUDE_CODE_OAUTH_TOKEN
 * (the injected subscription token) is preserved — Claude Code reads it for auth.
 */
export function runClaudeCli(prompt: string, model: string): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  return new Promise((resolve, reject) => {
    const HOME = process.env.CLAUDE_CWD || "/tmp/claude-home";
    mkdirSync(HOME, { recursive: true });
    const env = { ...process.env, HOME, ANTHROPIC_API_KEY: "" }; // subscription-only; keep CLAUDE_CODE_OAUTH_TOKEN
    const bin = resolveClaudeBin();
    const child = execFile(
      bin,
      ["-p", "--model", model, "--output-format", "json", "--dangerously-skip-permissions"],
      { timeout: CLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, cwd: HOME, env },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`claude cli (${model}): ${err.message.slice(0, 160)} ${String(stderr).slice(0, 160)}`));
        let j: ClaudeCliJson;
        try { j = JSON.parse(stdout) as ClaudeCliJson; }
        catch { return reject(new Error(`claude cli (${model}): non-JSON output: ${stdout.slice(0, 160)}`)); }
        if (j.is_error || j.subtype !== "success") {
          return reject(new Error(`claude cli (${model}) error: ${String(j.result ?? j.subtype).slice(0, 160)}`));
        }
        const text = j.result ?? "";
        if (!text.trim()) return reject(new Error(`claude cli (${model}): empty result`));
        resolve({ text, inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 });
      },
    );
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

/** Anthropic ideation via the subscription Claude Code CLI (NO API key). */
export async function proposeWithClaudeCli(
  lessons: string[],
  marketNotes: string,
  championSummary: string,
  nProposals = 4,
  model = EVOLUTION_MODEL,
): Promise<{ proposals: LlmProposal[]; usage: LlmUsage }> {
  const prompt = `${buildPrompt(lessons, marketNotes, nProposals, championSummary)}

Output ONLY a JSON object {"proposals":[{"rationale":str,"strategy":{...}}]} that conforms to this schema: ${JSON.stringify(PROPOSAL_SCHEMA)}. No prose, no markdown fences.`;
  const { text, inputTokens, outputTokens } = await runClaudeCli(prompt, model);
  const price = priceFor(model);
  return {
    proposals: parseProposals(text),
    usage: {
      provider: "anthropic-cli", model,
      inputTokens, outputTokens,
      // Metric only — the subscription CLI is flat-rate, not billed per token.
      costUsd: (inputTokens * price.in + outputTokens * price.out) / 1_000_000,
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

/**
 * Subscription Claude CLI first (when available — i.e. the CLI is on PATH);
 * on any error fall back to DeepSeek (OpenRouter). No Anthropic API path.
 * `allowClaudeCli` lets a caller force-skip the CLI (e.g. Trigger cloud, where
 * the binary/creds don't exist) so it goes straight to DeepSeek.
 */
export async function propose(
  keys: { openrouter?: string },
  budgetLeftUsd: number,
  lessons: string[],
  marketNotes: string,
  championSummary: string,
  nProposals = 4,
  opts?: { allowClaudeCli?: boolean; model?: string },
): Promise<{ proposals: LlmProposal[]; usage: LlmUsage } | { proposals: []; usage: null; skipped: string }> {
  const allowCli = opts?.allowClaudeCli ?? (process.env.EVOLUTION_DISABLE_CLI !== "1");
  if (allowCli && budgetLeftUsd > -1) {
    try {
      return await proposeWithClaudeCli(lessons, marketNotes, championSummary, nProposals, opts?.model ?? EVOLUTION_MODEL);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`claude cli ideation failed (${msg.slice(0, 160)}), falling back to deepseek`);
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
