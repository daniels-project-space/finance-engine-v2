// Single source of truth for which Claude model each ideation lane uses, and
// the typo-proof resolver that keeps a stale/invalid id (like the old
// "claude-fable-5") from ever silently killing the loop.
//
// AUTH POLICY: Anthropic calls go through the locally-authenticated Claude Code
// CLI on Daniel’s Max SUBSCRIPTION (see src/engine/llm.ts runClaudeCli). The
// Anthropic API / ANTHROPIC_API_KEY path is intentionally removed — never bill
// console credits. DeepSeek (OpenRouter) remains the only non-Anthropic backup.

export type Lane = "strategy" | "data_miner" | "risk_refiner" | "discovery";

// Models verified callable via `claude -p --model <id>` on this VPS.
const KNOWN = new Set([
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-opus-4-7",
  "claude-opus-4-6",
]);

const FALLBACK = "claude-sonnet-4-6";

// Per-lane defaults (mission spec). Strategy gets Opus; the rest get Sonnet.
// Env override per lane: EVOLUTION_MODEL_STRATEGY, EVOLUTION_MODEL_DATA_MINER,
// EVOLUTION_MODEL_RISK_REFINER, EVOLUTION_MODEL_DISCOVERY. A blanket
// EVOLUTION_MODEL overrides every lane. Unknown id -> WARN + FALLBACK.
const LANE_DEFAULT: Record<Lane, string> = {
  strategy: "claude-opus-4-8",
  data_miner: "claude-sonnet-4-6",
  risk_refiner: "claude-sonnet-4-6",
  discovery: "claude-sonnet-4-6",
};

const LANE_ENV: Record<Lane, string> = {
  strategy: "EVOLUTION_MODEL_STRATEGY",
  data_miner: "EVOLUTION_MODEL_DATA_MINER",
  risk_refiner: "EVOLUTION_MODEL_RISK_REFINER",
  discovery: "EVOLUTION_MODEL_DISCOVERY",
};

function resolve(candidate: string | undefined, where: string): string | undefined {
  const m = (candidate ?? "").trim();
  if (!m) return undefined;
  if (KNOWN.has(m)) return m;
  console.warn(`[model] ${where} model "${m}" is not a known/valid id — ignoring (will fall back)`);
  return undefined;
}

/** Resolve the model id for a lane. Order: per-lane env -> blanket EVOLUTION_MODEL -> lane default -> sonnet fallback. */
export function modelForLane(lane: Lane): string {
  return (
    resolve(process.env[LANE_ENV[lane]], `${lane} (${LANE_ENV[lane]})`) ??
    resolve(process.env.EVOLUTION_MODEL, "EVOLUTION_MODEL") ??
    resolve(LANE_DEFAULT[lane], `${lane} default`) ??
    FALLBACK
  );
}

/** Default ideation model (strategy lane) — used where no lane is specified. */
export function evolutionModel(): string {
  return modelForLane("strategy");
}

export const EVOLUTION_MODEL = evolutionModel();

// Per-1M-token pricing for the metric/log readout ONLY. The subscription CLI is
// flat-rate, so these never become a console charge — the loop’s USD budget gate
// treats CLI ideation as ~free (see llm.ts). Pricing verified via /claude-api.
export const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

export function priceFor(model: string): { in: number; out: number } {
  return MODEL_PRICING[model] ?? { in: 3, out: 15 };
}
