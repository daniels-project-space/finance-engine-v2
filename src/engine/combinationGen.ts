// COMBINATION generator — instantiate portfolio / overlay candidates with searched
// composition (which blocks, what allocation/weights, what leverage, what mode).
// Mirrors trendbetaGen: generate(seed) -> doc, validate -> string[], hash + family.

import { createHash } from "node:crypto";
import type { Block, CombinationDoc, CombineMode, AllocScheme } from "./combination";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T>(rng: () => number, xs: T[]): T => xs[Math.floor(rng() * xs.length) % xs.length];
const ri = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

// The liquid majors the chop-trend mechanism is strong on (the CORE-4 set + a few).
const MAJORS = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "AVAX/USDT", "LINK/USDT", "LTC/USDT"];
const SMA_SEED = [100, 120, 150, 200];
const CHOP_SEED = [45, 50, 55];
const ALLOCS: AllocScheme[] = ["equal", "invvol", "erc", "concentrate"];

function block(rng: () => number, symbol: string): Block {
  return { symbol, smaWin: pick(rng, SMA_SEED), chopThr: pick(rng, CHOP_SEED) };
}

/**
 * Generate a combination candidate. Seed-driven so the same seed is reproducible.
 * Rolls mode (portfolio vs overlay), the block set, the allocation scheme, leverage,
 * and (for concentrate) searched per-block weights. Biased toward Daniel's winning
 * shapes: the CORE-4 4-coin portfolio and the trend×regime overlay.
 */
export function generateCombination(seed: number): CombinationDoc {
  const rng = mulberry32(seed);
  const mode: CombineMode = rng() < 0.65 ? "portfolio" : "overlay";  // mostly portfolios (the proven lever)

  if (mode === "overlay") {
    // base block × gate block (regime agreement). Use two different coins/params so
    // the gate is a genuinely different regime, OR a slower trend filter as the gate.
    const baseSym = pick(rng, MAJORS.slice(0, 4));
    const base: Block = block(rng, baseSym);
    // gate = a SLOWER trend on the same coin (a higher-timeframe regime confirm) OR a
    // different major's trend (cross-asset regime). Slower SMA = the de-risk gate.
    const gate: Block = rng() < 0.6
      ? { symbol: baseSym, smaWin: pick(rng, [150, 200]), chopThr: pick(rng, CHOP_SEED) }
      : block(rng, pick(rng, MAJORS.slice(0, 4)));
    return {
      name: `cmb_overlay_${baseSym.split("/")[0].toLowerCase()}_${seed.toString(36)}`, kind: "combination", tf: "1d",
      mode: "overlay", blocks: [base, gate], alloc: "equal", leverage: 1,
      hypothesis: `Overlay: ${baseSym.split("/")[0]} chop-trend (SMA${base.smaWin}/chop${base.chopThr}) gated by a ${gate.symbol === baseSym ? "slower same-coin" : gate.symbol.split("/")[0] + " cross-asset"} trend regime (SMA${gate.smaWin}) — go long ONLY when both the fast signal AND the regime agree, else cash. De-risks at a different moment than the base alone.`,
    };
  }

  // PORTFOLIO: pick 2-4 distinct majors (bias to the CORE-4 set), an allocation
  // scheme, and modest leverage. This is the CORE-4 class the engine can now invent.
  const nCoins = ri(rng, 2, 4);
  const pool = [...MAJORS];
  const chosen: string[] = [];
  // bias the first picks toward the strongest majors (BTC/ETH/SOL/BNB)
  const strong = MAJORS.slice(0, 4);
  while (chosen.length < nCoins && pool.length) {
    const fromStrong = chosen.length < 2 && rng() < 0.8;
    const src = fromStrong ? strong.filter((s) => !chosen.includes(s)) : pool.filter((s) => !chosen.includes(s));
    if (!src.length) break;
    const sym = pick(rng, src);
    chosen.push(sym);
  }
  const blocks = chosen.map((s) => block(rng, s));
  const alloc = pick(rng, ALLOCS);
  const leverage = pick(rng, [1, 1, 1.2, 1.35, 1.45]); // mostly 1x, some modest leverage within budget
  const concWeights = alloc === "concentrate" ? blocks.map(() => 0.2 + rng() * 0.8) : undefined;
  return {
    name: `cmb_port_${chosen.length}c_${alloc}_${seed.toString(36)}`, kind: "combination", tf: "1d",
    mode: "portfolio", blocks, alloc, leverage, concWeights,
    hypothesis: `Portfolio: ${chosen.map((s) => s.split("/")[0]).join("+")} chop-trend, ${alloc}-weighted${leverage > 1 ? `, levered ${leverage}x` : ""}. Holds each coin only while it trends and isn't chopping; diversification across coins smooths the combined drawdown and captures whichever coin is trending. The CORE-4 class.`,
  };
}

/** validate: returns error strings; [] === valid. */
export function validateCombination(doc: CombinationDoc): string[] {
  const e: string[] = [];
  if (doc.kind !== "combination") e.push("kind must be 'combination'");
  if (!Array.isArray(doc.blocks) || doc.blocks.length < 2) e.push("need >=2 blocks");
  if (doc.blocks.length > 5) e.push("too many blocks (>5)");
  if (doc.mode === "overlay" && doc.blocks.length !== 2) e.push("overlay needs exactly 2 blocks [base,gate]");
  for (const b of doc.blocks ?? []) {
    if (!b.symbol || !b.symbol.includes("/")) e.push(`bad block symbol ${b.symbol}`);
    if (!(b.smaWin >= 20 && b.smaWin <= 400)) e.push(`block smaWin ${b.smaWin} out of range`);
    if (!(b.chopThr >= 30 && b.chopThr <= 70)) e.push(`block chopThr ${b.chopThr} out of range`);
  }
  // portfolio blocks must be distinct coins (diversification); overlay may share a coin
  if (doc.mode === "portfolio") {
    const syms = new Set(doc.blocks.map((b) => b.symbol));
    if (syms.size !== doc.blocks.length) e.push("portfolio blocks must be distinct coins");
  }
  if (!(doc.leverage >= 1 && doc.leverage <= 2)) e.push(`leverage ${doc.leverage} out of [1,2]`);
  if (!["equal", "invvol", "erc", "concentrate"].includes(doc.alloc)) e.push(`bad alloc ${doc.alloc}`);
  return e;
}

/** exact hash: identity of the composition (mode + blocks + alloc + leverage). */
export function combinationHash(doc: CombinationDoc): string {
  const sig = JSON.stringify({
    m: doc.mode, a: doc.alloc, lev: doc.leverage,
    b: doc.blocks.map((b) => [b.symbol, b.smaWin, b.chopThr]),
    cw: doc.concWeights?.map((x) => Math.round(x * 100)),
  });
  return createHash("sha256").update("cmb:" + sig).digest("hex").slice(0, 24);
}

/** family hash: ignores params/weights — the SHAPE (mode + coin set). So the 10-cap
 *  per family limits how many variants of "4-coin BTC+ETH+SOL+BNB portfolio" we breed. */
export function combinationFamilyHash(doc: CombinationDoc): string {
  const coins = [...new Set(doc.blocks.map((b) => b.symbol))].sort();
  return createHash("sha256").update(`cmbfam:${doc.mode}:${coins.join(",")}`).digest("hex").slice(0, 24);
}
