// Runtime configuration with safe defaults; overridable via Convex config table.
import { DEFAULT_FLOORS, type GateFloors } from "../engine/types";

export interface AppConfig {
  universe: string[];
  primarySymbol: string;
  tf: string;
  /** ISO date string; data >= sealDate is sealed (S6 one-shot only) */
  sealDate: string;
  historyStart: string;
  floors: GateFloors;
  autoPromote: boolean;
  paperStartEquity: number;
  killSwitch: { dailyDD: number; weeklyDD: number; monthlyDD: number };
  evo: { batchGp: number; batchFresh: number; batchLlm: number; maxCandidatesPerDay: number };
  llmDailyBudgetUsd: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  universe: ["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT"],
  primarySymbol: "BTC/USDT",
  tf: "1h",
  sealDate: "2026-02-01",
  historyStart: "2021-06-01",
  floors: DEFAULT_FLOORS,
  autoPromote: true,
  paperStartEquity: 10_000,
  killSwitch: { dailyDD: -0.05, weeklyDD: -0.10, monthlyDD: -0.20 },
  evo: { batchGp: 14, batchFresh: 6, batchLlm: 4, maxCandidatesPerDay: 150 },
  llmDailyBudgetUsd: 1.0,
};

export function mergeConfig(json: string | null): AppConfig {
  if (!json) return DEFAULT_CONFIG;
  try {
    const parsed = JSON.parse(json) as Partial<AppConfig>;
    return { ...DEFAULT_CONFIG, ...parsed, floors: { ...DEFAULT_FLOORS, ...(parsed.floors ?? {}) }, killSwitch: { ...DEFAULT_CONFIG.killSwitch, ...(parsed.killSwitch ?? {}) }, evo: { ...DEFAULT_CONFIG.evo, ...(parsed.evo ?? {}) } };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function todayKey(prefix: string): string {
  return `${prefix}:${new Date().toISOString().slice(0, 10)}`;
}
