// WAVE-3a signal catalog (SHADOW). Bridges the DSL/compile layer to the IC layer:
//   - SIGNAL_CATALOG: every standalone numeric INPUT/derived signal the engine
//     can reason about, each as a DSL Expr that compile.evalNum can evaluate.
//   - buildSignalMatrix(): evaluate the catalog on a bar series into named arrays.
//   - usedSignals(): which catalog signals a candidate's DSL actually references.
//
// Used by the gauntlet shadow-IC block (metrics.signalIC) and the IC-ranking
// script. Nothing here is bound to promotion.

import { evalNum, toArrays, type CompiledInputs } from "./compile";
import * as S from "./series";
import type { Bars, Expr } from "./types";

export interface CatalogSignal { name: string; expr: Expr }

// A representative, mostly-orthogonal set of standalone signals: classic
// price/vol/flow features PLUS the WAVE-3a crypto-native ones. Periods are fixed
// here (this is a descriptive catalog, not the tuner) so the ranking is stable.
export const SIGNAL_CATALOG: CatalogSignal[] = [
  // --- price / trend / momentum ---
  { name: "roc_24", expr: { op: "roc", src: { op: "price", field: "close" }, period: { op: "const", value: 24 } } },
  { name: "roc_96", expr: { op: "roc", src: { op: "price", field: "close" }, period: { op: "const", value: 96 } } },
  { name: "slope_48", expr: { op: "slope", src: { op: "price", field: "close" }, period: { op: "const", value: 48 } } },
  { name: "zscore_close_96", expr: { op: "zscore", src: { op: "price", field: "close" }, period: { op: "const", value: 96 } } },
  { name: "rsi_14", expr: { op: "rsi", src: { op: "price", field: "close" }, period: { op: "const", value: 14 } } },
  // --- volatility / volume ---
  { name: "atr_ratio_14", expr: { op: "div", a: { op: "atr", src: { op: "price", field: "close" }, period: { op: "const", value: 14 } }, b: { op: "sma", src: { op: "price", field: "close" }, period: { op: "const", value: 20 } } } },
  { name: "stdev_pctrank_30", expr: { op: "pctrank", src: { op: "stdev", src: { op: "price", field: "close" }, period: { op: "const", value: 30 } }, period: { op: "const", value: 100 } } },
  { name: "vol_zscore_50", expr: { op: "zscore", src: { op: "price", field: "volume" }, period: { op: "const", value: 50 } } },
  // --- calendar ---
  { name: "hourutc", expr: { op: "hourutc" } },
  { name: "dowutc", expr: { op: "dowutc" } },
  // --- funding (raw + WAVE-3a dynamics) ---
  { name: "funding", expr: { op: "funding" } },
  { name: "fundroc", expr: { op: "fundroc" } },
  { name: "fundzscore", expr: { op: "fundzscore" } },
  { name: "fundaccel", expr: { op: "fundaccel" } },
  { name: "fundmom", expr: { op: "fundmom" } },
  // --- WAVE-3a basis / OI / positioning ---
  { name: "basis", expr: { op: "basis" } },
  { name: "basis_zscore_96", expr: { op: "zscore", src: { op: "basis" }, period: { op: "const", value: 96 } } },
  { name: "basis_roc_24", expr: { op: "roc", src: { op: "basis" }, period: { op: "const", value: 24 } } },
  { name: "oi_zscore_168", expr: { op: "zscore", src: { op: "oi" }, period: { op: "const", value: 168 } } },
  { name: "oi_roc_24", expr: { op: "roc", src: { op: "oi" }, period: { op: "const", value: 24 } } },
  { name: "lsr_zscore_96", expr: { op: "zscore", src: { op: "lsr" }, period: { op: "const", value: 96 } } },
];

/** Evaluate the catalog on a bar series → named Float64Array signals. */
export function buildSignalMatrix(bars: Bars, catalog: CatalogSignal[] = SIGNAL_CATALOG): { name: string; values: Float64Array }[] {
  const inp = toArrays(bars);
  return buildSignalMatrixFromInputs(inp, catalog);
}

export function buildSignalMatrixFromInputs(inp: CompiledInputs, catalog: CatalogSignal[] = SIGNAL_CATALOG): { name: string; values: Float64Array }[] {
  const memo = new Map<string, Float64Array | Uint8Array>();
  return catalog.map((c) => ({ name: c.name, values: evalNum(c.expr, inp, {}, memo) }));
}

/** True if a series has any non-zero finite value (so we skip all-zero unavailable inputs). */
export function hasData(values: ArrayLike<number>): boolean {
  for (let i = 0; i < values.length; i++) { const v = values[i]; if (Number.isFinite(v) && v !== 0) return true; }
  return false;
}

// ----------------------------------------------------------- used-signal walk
// The standalone leaf inputs we attribute to a candidate for shadow-IC. We map a
// candidate's referenced inputs onto a small canonical signal set (one entry per
// distinct leaf family that appears) so metrics.signalIC reflects the signals it
// actually trades on, not every catalog member.
const LEAF_TO_SIGNAL: Record<string, string> = {
  funding: "funding", fundroc: "fundroc", fundzscore: "fundzscore",
  fundaccel: "fundaccel", fundmom: "fundmom", basis: "basis", oi: "oi", lsr: "lsr",
  hourutc: "hourutc", dowutc: "dowutc",
};

/** Walk a candidate's expressions and return the catalog signals it references.
 *  Price-derived structure maps to a generic momentum/trend proxy; the
 *  crypto-native + calendar leaves map directly. Returns deduped catalog exprs. */
export function usedSignals(exprs: (Expr | undefined)[]): CatalogSignal[] {
  const leaves = new Set<string>();
  let usesPrice = false, usesVolume = false;
  const visit = (e: Expr | undefined) => {
    if (!e || typeof e !== "object") return;
    const n = e as Record<string, unknown> & { op: string };
    if (LEAF_TO_SIGNAL[n.op]) leaves.add(LEAF_TO_SIGNAL[n.op]);
    if (n.op === "price") { if (n.field === "volume") usesVolume = true; else usesPrice = true; }
    for (const k of ["src", "period", "a", "b"]) visit(n[k] as Expr | undefined);
  };
  for (const e of exprs) visit(e);

  const out: CatalogSignal[] = [];
  const byName = new Map(SIGNAL_CATALOG.map((c) => [c.name, c]));
  // crypto-native + calendar leaves: attach a representative normalized form
  const leafRepresentative: Record<string, string> = {
    funding: "funding", fundroc: "fundroc", fundzscore: "fundzscore",
    fundaccel: "fundaccel", fundmom: "fundmom",
    basis: "basis_zscore_96", oi: "oi_zscore_168", lsr: "lsr_zscore_96",
    hourutc: "hourutc", dowutc: "dowutc",
  };
  for (const leaf of leaves) {
    const sigName = leafRepresentative[leaf];
    const c = sigName && byName.get(sigName);
    if (c) out.push(c);
  }
  // price/volume structure: use a generic momentum + vol-flow proxy
  if (usesPrice) { const c = byName.get("roc_24"); if (c) out.push(c); const c2 = byName.get("slope_48"); if (c2) out.push(c2); }
  if (usesVolume) { const c = byName.get("vol_zscore_50"); if (c) out.push(c); }
  // dedupe by name
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}


// ============================================================================
// CALIBRATION PASS: IC-STEERING HELPERS
// Translate a persisted signal-IC report into generation steering. SHADOW DATA,
// LIVE USE: the report only ranks predictive power; it never binds promotion.
// Both helpers are cold-start safe (empty/undefined report => neutral output).
// ============================================================================

export type IcRankedRow = { name: string; icIR: number; pooledIC?: number; tStat?: number; cryptoNative?: boolean; redundant?: boolean };

/** Map a catalog signal name to its crypto-leaf family (or null for price math). */
function leafFamilyOf(name: string): "funding" | "basis" | "oi" | "lsr" | null {
  if (name.startsWith("fund") || name === "funding") return "funding";
  if (name.startsWith("basis")) return "basis";
  if (name.startsWith("oi")) return "oi";
  if (name.startsWith("lsr")) return "lsr";
  return null;
}

/**
 * Per-crypto-leaf-family weights from the IC ranking, for the GP grammar sampler.
 * Weight = 1 + max(0, |IC-IR|) of the BEST (non-redundant) signal in that family,
 * so families with predictive crypto inputs are sampled more often. Families with
 * no signal in the report keep the neutral weight 1. Returns null when the report
 * has no usable crypto rows (=> uniform sampling, unchanged behavior).
 */
export function icFamilyWeights(ranked: IcRankedRow[] | undefined | null): Record<"funding" | "basis" | "oi" | "lsr", number> | null {
  if (!ranked || ranked.length === 0) return null;
  const best: Record<string, number> = { funding: 0, basis: 0, oi: 0, lsr: 0 };
  let any = false;
  for (const r of ranked) {
    const fam = leafFamilyOf(r.name);
    if (!fam) continue;
    if (r.redundant) continue; // don't reward a signal that just echoes a better one
    const ir = Math.abs(Number(r.icIR) || 0);
    if (ir > best[fam]) best[fam] = ir;
    any = true;
  }
  if (!any) return null;
  return { funding: 1 + best.funding, basis: 1 + best.basis, oi: 1 + best.oi, lsr: 1 + best.lsr };
}

/**
 * Compact, prompt-ready ranking of the most predictive signals for the LLM. Lists
 * the top-N by |IC-IR| (skipping redundant ones), flagging crypto-native inputs so
 * the model prefers basis / funding / OI dynamics when they actually predict.
 * Returns "" when the report is empty (the prompt then omits the section).
 */
export function icRankingText(ranked: IcRankedRow[] | undefined | null, topN = 10): string {
  if (!ranked || ranked.length === 0) return "";
  const rows = ranked
    .filter((r) => !r.redundant && Number.isFinite(Number(r.icIR)))
    .slice()
    .sort((a, b) => Math.abs(Number(b.icIR)) - Math.abs(Number(a.icIR)))
    .slice(0, topN);
  if (!rows.length) return "";
  return rows
    .map((r, i) => `${i + 1}. ${r.name}${r.cryptoNative ? " (crypto-native)" : ""}: IC-IR ${Number(r.icIR).toFixed(2)}`)
    .join("\n");
}
