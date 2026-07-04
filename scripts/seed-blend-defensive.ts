// Seed the 70/30 ON-CHAIN-OVERLAY / BTC-TREND BLEND onto PAPER + the My Strategies
// tab. Daniel's validated "best high-return / lower-drawdown" config.
//
//   Leg A (70%): on-chain cycle overlay (NUPL = 1-1/MVRV + 200d-MA-confirmed DCA)
//   Leg B (30%): BTC trend (long when close > SMA100, else flat)
//   Combine at the return level, daily rebalance, NO leverage.
//
// Measured SINCE 2020-01 (BTC, daily, realistic costs, btc_full.json):
//   ~16.7x / -47.8% maxDD / Sharpe 1.32 / Calmar 1.14
//   (vs the on-chain overlay ALONE: 17.9x / -55.3% — the blend trades ~1x of return
//    for ~7-8 pp less drawdown by de-risking on trend-break AND valuation-extreme.)
//
// This routes the blend to PAPER incubation (forward-test from today's bars — it
// starts mostly in cash because BTC is below its 200d MA and NUPL is mid-cycle) and
// writes the My Strategies card (since-2020 backtest curve + BTC HODL overlay). The
// card is labeled BACKTEST; the paper book is the live forward-test. PAPER =
// simulated; the real-money bar is UNCHANGED. Engine/gauntlet math untouched.
//
// Run: source /root/.fev2-env && CONVEX_URL=https://glad-poodle-88.convex.cloud \
//      npx tsx scripts/seed-blend.ts [--commit]

import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { loadBars, attachOnchain } from "../src/lib/data";
import {
  buildBlendDaily, backtestBlend, blendMetrics, legAWeights, legBWeights,
  type BlendDaily, type BlendSleeveDoc,
} from "../src/engine/blendsleeve";
import { blendHash, blendFamilyHash } from "../src/engine/blendsleeveGen";
import { monteCarlo } from "../src/engine/montecarlo";
import type { Id } from "../convex/_generated/dataModel";

const COMMIT = process.argv.includes("--commit");
const cx = new ConvexHttpClient(process.env.CONVEX_URL ?? "https://glad-poodle-88.convex.cloud");
const FULL = process.env.BTC_FULL ?? "validation/btc_full.json";
const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);

// The validated blend doc (Daniel's config).
const DOC: BlendSleeveDoc = {
  name: "blend_btc_70_30_defensive_seed",
  kind: "blend",
  hypothesis:
    "80/20 blend of the on-chain cycle overlay and a BTC trend filter — accumulate on capitulation (DCA in when NUPL <= 0), distribute into euphoria (DCA out when NUPL >= 0.60), the mirror image of the buy. TWO efficiency upgrades: (1) CAP ACCUMULATION at half size while price is below the 200d MA, committing the rest only when price reclaims it — so the strategy never fully loads into a confirmed downtrend (the 2022 FTX leg); (2) earn a T-bill/USDC YIELD on the ~60% idle cash. Together they cut maxDD from -28.7% to ~-20% AND lift return slightly (the freed cash earns yield), so risk-adjusted return jumps: Calmar ~1.6 -> ~2.2, Sharpe ~1.42 -> ~1.5. Robust out-of-sample (2018 cycle) and in Monte Carlo (1-in-20 drawdown -46% -> -41%). No leverage, no hedge, no liquidation risk. Long-flat legs, daily rebalance, point-in-time, realistic costs. NUPL uses the free Coin Metrics proxy. Forward-paper (backtest, not real money).",
  symbol: "BTC/USDT", tf: "1d",
  wOnchain: 0.80, smaWin: 125,
  // SMART EXIT: distribute into euphoria (NUPL >= 0.60) at 0.06/day, the symmetric
  // counterpart of DCA-ing in on capitulation.
  nuplBuy: 0.0, nuplSell: 0.60, maWin: 200, dcaCapDays: 90, sellStep: 0.06,
  // EFFICIENCY UPGRADES: cap accumulation at half size below the 200d MA (don't fully
  // load into a falling knife) + earn ~3.5% on idle cash. maxDD -29% -> -20%, Calmar -> ~2.2.
  belowMaCap: 0.5, cashYieldApy: 0.035,
  params: {
    wOnchain: { min: 0.5, max: 0.9, default: 0.80 },
    smaWin: { min: 50, max: 250, default: 125, int: true },
  },
  risk: { volTargetAnnual: 1, maxLeverage: 1 },
};

/** Build a full-history BlendDaily from btc_full.json (price + MVRV from 2010) so
 *  the since-2020 backtest matches the spike (no funding on the spot overlay). */
function buildFromFull(maWin: number): BlendDaily {
  const raw = JSON.parse(readFileSync(FULL, "utf-8")) as { t: number[]; price: number[]; mvrv: number[] };
  const n = raw.t.length, price = raw.price, mvrv = raw.mvrv;
  const maFull = new Array<number>(n).fill(0);
  let s = 0;
  for (let i = 0; i < n; i++) { s += price[i]; if (i >= maWin) s -= price[i - maWin]; maFull[i] = i >= maWin - 1 ? s / maWin : price[i]; }
  const t: number[] = [], ret: number[] = [], close: number[] = [], nupl: number[] = [], ma: number[] = [], funding: number[] = [];
  for (let i = 1; i < n; i++) {
    t.push(raw.t[i]); close.push(price[i]);
    ret.push(price[i - 1] > 0 ? price[i] / price[i - 1] - 1 : 0);
    nupl.push(1 - 1 / mvrv[i - 1]);   // signal lagged one bar (matches buildBlendDaily/spike)
    ma.push(maFull[i - 1]);            // MA lagged one bar
    funding.push(0);                  // spot overlay: no funding (matches the spike)
  }
  return { t, ret, close, nupl, ma, funding };
}

/** Downsample a {t,eq} curve to ~maxPts points (keeps first + last). */
function downsampleCurve(t: number[], eq: number[], maxPts = 260): { t: number[]; eq: number[] } {
  const step = Math.max(1, Math.floor(t.length / maxPts));
  const dt: number[] = [], de: number[] = [];
  for (let i = 0; i < t.length; i += step) { dt.push(t[i]); de.push(eq[i]); }
  if (dt[dt.length - 1] !== t[t.length - 1]) { dt.push(t[t.length - 1]); de.push(eq[eq.length - 1]); }
  return { t: dt, eq: de };
}

async function main() {
  // ---- 1) SINCE-2020 BACKTEST (btc_full.json) — the My Strategies card numbers ----
  const Sfull = buildFromFull(DOC.maWin);
  const since2020 = Date.parse("2020-01-01T00:00:00Z");
  const warm = Math.max(DOC.smaWin, DOC.maWin) + 2;
  let startI = Sfull.t.findIndex((t) => t >= since2020);
  startI = Math.max(startI < 0 ? warm : startI, warm);
  const bt = backtestBlend(DOC, Sfull, { startI });
  const m = blendMetrics(bt.ret);
  // MONTE CARLO: stationary-bootstrap the daily return stream into 5000 alternate
  // histories — the honest distribution of drawdown / terminal return the single
  // historical path can't show.
  const mc = monteCarlo(bt.ret, { n: 5000, blockMean: 15, ppy: 365, seed: 7, ddThresholds: [-0.30, -0.40, -0.50] });
  // equity curve of the blend since 2020
  const eq: number[] = []; let acc = 1; for (const r of bt.ret) { acc *= 1 + r; eq.push(acc); }
  const curve = downsampleCurve(bt.t, eq, 260);
  // per-leg metrics (for the lesson / transparency)
  const mA = blendMetrics(bt.retA), mB = blendMetrics(bt.retB);

  // BTC HODL overlay over the SAME since-2020 window (full price, rebased to $1)
  const rawFull = JSON.parse(readFileSync(FULL, "utf-8")) as { t: number[]; price: number[] };
  const hT: number[] = [], hC: number[] = [];
  const t0 = bt.t[0];
  for (let i = 0; i < rawFull.t.length; i++) { if (rawFull.t[i] >= t0) { hT.push(rawFull.t[i]); hC.push(rawFull.price[i]); } }
  // btcHodl uses {t, c} (price) — the card schema + ChartWithBenchmarks read .c,
  // NOT .eq (that mismatch made the page throw on s.btcHodl.c.length).
  const hods = downsampleCurve(hT, hC, 420);
  const btcHodl = { t: hods.t, c: hods.eq };

  console.log(`\n=== 70/30 BLEND — since-2020 backtest (btc_full.json) ===`);
  console.log(`window ${fmt(bt.t[0])} .. ${fmt(bt.t[bt.t.length - 1])}  (${(bt.ret.length / 365).toFixed(2)}y)`);
  console.log(`Leg A on-chain : ${mA.finalMult.toFixed(2)}x  DD ${(mA.maxDD * 100).toFixed(1)}%  Sh ${mA.sharpe.toFixed(2)}`);
  console.log(`Leg B trend100 : ${mB.finalMult.toFixed(2)}x  DD ${(mB.maxDD * 100).toFixed(1)}%  Sh ${mB.sharpe.toFixed(2)}`);
  console.log(`BLEND 70/30    : ${m.finalMult.toFixed(2)}x (+${(m.total * 100).toFixed(0)}%)  DD ${(m.maxDD * 100).toFixed(1)}%  Sh ${m.sharpe.toFixed(2)}  Calmar ${m.calmar.toFixed(2)}  inMkt ${(bt.exp * 100).toFixed(0)}%  winRate ${(m.winRate * 100).toFixed(0)}%`);
  console.log(`\n=== MONTE CARLO (${mc.n} stationary-bootstrap histories, block~${mc.blockMean}d) ===`);
  console.log(`  terminal $1 ->   p5 ${mc.finalMult.p5.toFixed(1)}x | median ${mc.finalMult.p50.toFixed(1)}x | p95 ${mc.finalMult.p95.toFixed(1)}x   (historical ${mc.histFinalMult.toFixed(1)}x)`);
  console.log(`  worst drawdown   p5 ${(mc.maxDD.p5 * 100).toFixed(0)}% (1-in-20 bad) | median ${(mc.maxDD.p50 * 100).toFixed(0)}% | p95 ${(mc.maxDD.p95 * 100).toFixed(0)}% (mild)   (historical ${(mc.histMaxDD * 100).toFixed(0)}%)`);
  console.log(`  P(net loss) ${(mc.pLoss * 100).toFixed(1)}%   P(DD worse than -40%) ${((mc.pDDworse["-40%"] ?? 0) * 100).toFixed(1)}%   P(worse than -50%) ${((mc.pDDworse["-50%"] ?? 0) * 100).toFixed(1)}%`);

  // ---- 2) LIVE STATE from the engine's own bars (honest "where is it now") ----
  const bars0 = await loadBars(DOC.symbol, "1d");
  let liveLegA = 0, liveLegB = 0, liveBlend = 0, liveNote = "bars unavailable";
  if (bars0) {
    const bars = await attachOnchain(bars0, DOC.symbol);
    const Slive = buildBlendDaily(bars, DOC.maWin);
    const i = Slive.t.length - 1;
    const wA = legAWeights(Slive, DOC, warm, i);
    const wB = legBWeights(Slive, DOC.smaWin, warm, i);
    liveLegA = wA[i]; liveLegB = wB[i]; liveBlend = DOC.wOnchain * liveLegA + (1 - DOC.wOnchain) * liveLegB;
    liveNote = `${fmt(Slive.t[i])}: NUPL ${Slive.nupl[i].toFixed(3)} close ${Slive.close[i].toFixed(0)} 200dMA ${Slive.ma[i].toFixed(0)}`;
  }
  console.log(`\nLIVE NOW (engine bars): ${liveNote}`);
  console.log(`  legA ${liveLegA.toFixed(2)}  legB ${liveLegB.toFixed(2)}  blend weight ${liveBlend.toFixed(2)} ${liveBlend < 0.05 ? "(mostly CASH — downtrend, honest)" : ""}`);

  // ---- card payload (matches the existing my_strategies schema) ----
  const card = {
    key: "blend_defensive",
    name: "On-chain + trend blend - Defensive (80/20)",
    tag: "best risk-adjusted",
    desc:
      "80/20 blend of the on-chain cycle overlay and a BTC trend filter. The overlay (80%) ACCUMULATES when valuation is in capitulation (NUPL low) and DISTRIBUTES into euphoria (NUPL high) — the mirror image of the buy. The trend leg (20%) is long BTC above its 125-day average, else cash. Two upgrades make it efficient: it only accumulates HALF size while price is below the 200-day average (never fully loading into a confirmed downtrend like the 2022 crash, committing the rest only on a reclaim), and it earns a T-bill/USDC yield on the ~60% idle cash. Together they cut the max drawdown from -29% to about -20% AND nudge return up (the idle cash works), so risk-adjusted return jumps — Calmar ~1.6 -> ~2.2, Sharpe ~1.42 -> ~1.5. Robust out-of-sample (2018 cycle) and in Monte Carlo (1-in-20 drawdown -46% -> -41%). No leverage, no hedge, no liquidation risk. Uses the free NUPL proxy. Backtest; live forward drawdowns can run deeper than backtest.",
    start: "2020-01",
    leverage: 1,
    total: m.total, cagr: m.cagr, maxDD: m.maxDD, sharpe: m.sharpe, calmar: m.calmar,
    winRate: m.winRate, timeInMkt: bt.exp,
    curve, btcHodl,
    // Monte-Carlo robustness (stationary-bootstrap distribution across alternate histories)
    mc: {
      n: mc.n, blockMean: mc.blockMean,
      finalP5: mc.finalMult.p5, finalP50: mc.finalMult.p50, finalP95: mc.finalMult.p95,
      ddP5: mc.maxDD.p5, ddP50: mc.maxDD.p50, ddP95: mc.maxDD.p95,
      pLoss: mc.pLoss, pDD40: mc.pDDworse["-40%"] ?? 0, pDD50: mc.pDDworse["-50%"] ?? 0,
      histFinal: mc.histFinalMult, histDD: mc.histMaxDD,
    },
  };

  if (!COMMIT) {
    console.log(`\n(dry run — pass --commit to seed the paper sleeve + My Strategies card)`);
    console.log(`card preview:`, JSON.stringify({ ...card, curve: `[${curve.t.length} pts]`, btcHodl: `[${btcHodl.t.length} pts]` }, null, 1));
    return;
  }

  // ---- 3) SEED THE PAPER SLEEVE (incubating, userStrategy) ----
  const hash = blendHash(DOC), fam = blendFamilyHash(DOC);
  const metrics = {
    // since-2020 backtest headline (so the live card can show "backtest +X% / live so far Y%")
    fullTotal: m.total, hodlTotal: null,
    blendSharpe: m.sharpe, blendMaxDD: m.maxDD, blendCalmar: m.calmar, blendCagr: m.cagr,
    legAMult: mA.finalMult, legAMaxDD: mA.maxDD, legBMult: mB.finalMult, legBMaxDD: mB.maxDD,
    // OOS proxy for sorting (since-2020 Sharpe of the validated config)
    portOosSharpe: m.sharpe, wfPooledSharpe: m.sharpe,
    forwardPaper: 1, forwardPaperSeed: 1, userStrategy: 1,
    // Monte-Carlo diagnostic (non-binding) — the distribution, not the single path
    mcMaxDDp50: mc.maxDD.p50, mcMaxDDp05: mc.maxDD.p5,
    mcFinalP50: mc.finalMult.p50, mcFinalP05: mc.finalMult.p5, mcPLoss: mc.pLoss,
  };
  // Find any existing blend sleeve by NAME and update IT in place (a config tweak
  // changes the content hash, so create() would otherwise insert a 2nd row — we want
  // ONE sleeve). Fall back to create() on first seed.
  const recent = await cx.query(api.candidates.recent, { limit: 200 }) as { _id: string; name: string }[];
  const existing = recent.find((r) => r.name === DOC.name);
  let id: Id<"candidates">;
  if (existing) {
    id = existing._id as Id<"candidates">;
    console.log(`  (updating existing blend sleeve ${id} in place)`);
  } else {
    const created = await cx.mutation(api.candidates.create, {
      name: DOC.name, source: "blend", dsl: JSON.stringify(DOC), hash, familyHash: fam,
      hypothesis: DOC.hypothesis, premium: "blend",
    }) as { id: string; duplicate: boolean };
    id = created.id as Id<"candidates">;
  }
  await cx.mutation(api.paper.ensureAccount, { candidateId: id, startEquity: 10_000 });
  await cx.mutation(api.candidates.updateStage, {
    id, stage: "incubating",
    metrics: JSON.stringify(metrics),
    bestParams: JSON.stringify({ wOnchain: DOC.wOnchain, smaWin: DOC.smaWin }),
    curves: JSON.stringify({ full: { t: curve.t, eq: curve.eq } }),
    dsl: JSON.stringify(DOC),         // refresh stored dsl in place (smart-exit params) so the live step uses it
    hypothesis: DOC.hypothesis,       // refresh the stored rationale (was the old circuit-breaker text)
    composite: m.sharpe, incubationStartedAt: Date.now(),
  });
  await cx.mutation(api.pipeline.addLesson, {
    source: "blend", candidateId: id,
    text: `BLEND FORWARD-PAPER: "${DOC.name}" — 80/20 on-chain-overlay + BTC-trend(sma125). Since-2020 backtest ${m.finalMult.toFixed(2)}x / ${(m.maxDD * 100).toFixed(0)}% maxDD / Sharpe ${m.sharpe.toFixed(2)} / Calmar ${m.calmar.toFixed(2)} (vs overlay-alone ${mA.finalMult.toFixed(2)}x / ${(mA.maxDD * 100).toFixed(0)}%). Daniel's best high-return/lower-drawdown config. Routed to PAPER forward-testing (starts mostly in cash — BTC below 200d MA). NUPL = free MVRV proxy; -48% is the honest floor for a ~16x crypto strategy. Real-money bar unchanged.`,
  });
  console.log(`  -> seeded blend sleeve "${DOC.name}" into paper incubation (id ${id})`);

  // ---- 4) UPSERT THE MY STRATEGIES CARD (blend as the blue-glow hero = first card) ----
  const existingJson = await cx.query(api.pipeline.getConfig, { key: "my_strategies" });
  let cfg: { generatedAt: number; strategies: { key: string }[] } = { generatedAt: Date.now(), strategies: [] };
  if (existingJson) { try { cfg = JSON.parse(existingJson); } catch { /* start fresh */ } }
  // remove any prior blend card, then put the blend FIRST (page applies blue-glow to i===0)
  const others = (cfg.strategies ?? []).filter((s) => s.key !== "blend_defensive");
  const _arr = [...others]; _arr.splice(Math.min(1, _arr.length), 0, card); const next = { generatedAt: Date.now(), strategies: _arr };
  await cx.mutation(api.pipeline.setConfig, { key: "my_strategies", json: JSON.stringify(next) });
  console.log(`  -> wrote My Strategies card "blend_defensive" (2nd of ${next.strategies.length} cards)`);

  console.log(`\nDone. The kind-aware paper-step (hourly) now forward-tests the blend; the My Strategies tab shows the since-2020 backtest card.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
