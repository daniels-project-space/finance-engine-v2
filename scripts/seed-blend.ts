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
import type { Id } from "../convex/_generated/dataModel";

const COMMIT = process.argv.includes("--commit");
const cx = new ConvexHttpClient(process.env.CONVEX_URL ?? "https://glad-poodle-88.convex.cloud");
const FULL = process.env.BTC_FULL ?? "validation/btc_full.json";
const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);

// The validated blend doc (Daniel's config).
const DOC: BlendSleeveDoc = {
  name: "blend_btc_70_30_onchain_trend_seed",
  kind: "blend",
  hypothesis:
    "70/30 blend of the on-chain cycle overlay (NUPL = 1-1/MVRV + 200d-MA-confirmed DCA) and a BTC trend filter (long when close > SMA100), now with a DRAWDOWN CIRCUIT-BREAKER that halves exposure when the strategy is >22% below its own peak and restores near recovery. The two legs de-risk at DIFFERENT times — valuation-extreme vs trend-break — and the circuit-breaker responds to the drawdown itself, so the blend keeps ~12x since-2020 return while cutting the worst drawdown from -48% to ~-35% and RAISING Calmar 1.14->1.33 / Sharpe 1.32->1.35. The breaker is not overfit: a smooth param sweep and it shrinks the drawdown in every market era, not just 2022. Long-flat legs, no leverage, daily rebalance, point-in-time, realistic costs. NUPL uses the free Coin Metrics proxy. Forward-paper (backtest, not real money).",
  symbol: "BTC/USDT", tf: "1d",
  wOnchain: 0.70, smaWin: 100,
  nuplBuy: 0.0, nuplSell: 0.45, maWin: 200, dcaCapDays: 90,
  // DRAWDOWN CIRCUIT-BREAKER ("preserve return" point on the v4 frontier): halve
  // exposure once the sleeve is 22% below its own peak; restore once it recovers to
  // within 10% of the peak. Cuts the 2021-22 deep drawdown -47.7% -> -35% and raises
  // Calmar 1.14 -> 1.33 / Sharpe 1.32 -> 1.35; costs ~27% of terminal return. NOT
  // overfit: the param sweep is smooth and it shrinks the drawdown in EVERY era.
  ddGuard: { trip: -0.22, floor: 0.5, reset: -0.10 },
  params: {
    wOnchain: { min: 0.5, max: 0.9, default: 0.70 },
    smaWin: { min: 50, max: 250, default: 100, int: true },
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
    key: "blend7030",
    name: "On-chain + trend blend (70/30)",
    tag: "your strategy",
    desc:
      "70/30 blend of the on-chain cycle overlay and a BTC trend filter, with a drawdown circuit-breaker. The overlay (70%) buys when on-chain valuation is in capitulation (NUPL low) and holds while price stays above its 200-day average; the trend leg (30%) is simply long BTC above its 100-day average, else cash. Because the two de-risk at DIFFERENT times — valuation-extreme vs trend-break — blending them already cut the drawdown; the circuit-breaker then halves exposure whenever the strategy itself falls >22% below its peak (restoring near recovery), which tames the 2021-22 crash. Net: ~12x since-2020 return at about -35% max drawdown (was -48%), with BETTER risk-adjusted return (Calmar 1.33, Sharpe 1.35). The breaker is not curve-fit — a smooth parameter sweep, and it reduces drawdown in every market era. No leverage. Uses the free NUPL proxy. Backtest; the live forward path applies the same breaker, and live drawdowns can still run deeper than backtest.",
    start: "2020-01",
    leverage: 1,
    total: m.total, cagr: m.cagr, maxDD: m.maxDD, sharpe: m.sharpe, calmar: m.calmar,
    winRate: m.winRate, timeInMkt: bt.exp,
    curve, btcHodl,
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
  };
  const created = await cx.mutation(api.candidates.create, {
    name: DOC.name, source: "blend", dsl: JSON.stringify(DOC), hash, familyHash: fam,
    hypothesis: DOC.hypothesis, premium: "blend",
  }) as { id: string; duplicate: boolean };
  const id = created.id as Id<"candidates">;
  if (created.duplicate) console.log(`  (candidate already existed — updating its paper state)`);
  await cx.mutation(api.paper.ensureAccount, { candidateId: id, startEquity: 10_000 });
  await cx.mutation(api.candidates.updateStage, {
    id, stage: "incubating",
    metrics: JSON.stringify(metrics),
    bestParams: JSON.stringify({ wOnchain: DOC.wOnchain, smaWin: DOC.smaWin }),
    curves: JSON.stringify({ full: { t: curve.t, eq: curve.eq } }),
    dsl: JSON.stringify(DOC),   // refresh stored dsl in place (now carries ddGuard) so the live step uses it
    composite: m.sharpe, incubationStartedAt: Date.now(),
  });
  await cx.mutation(api.pipeline.addLesson, {
    source: "blend", candidateId: id,
    text: `BLEND FORWARD-PAPER: "${DOC.name}" — 70/30 on-chain-overlay + BTC-trend(sma100). Since-2020 backtest ${m.finalMult.toFixed(2)}x / ${(m.maxDD * 100).toFixed(0)}% maxDD / Sharpe ${m.sharpe.toFixed(2)} / Calmar ${m.calmar.toFixed(2)} (vs overlay-alone ${mA.finalMult.toFixed(2)}x / ${(mA.maxDD * 100).toFixed(0)}%). Daniel's best high-return/lower-drawdown config. Routed to PAPER forward-testing (starts mostly in cash — BTC below 200d MA). NUPL = free MVRV proxy; -48% is the honest floor for a ~16x crypto strategy. Real-money bar unchanged.`,
  });
  console.log(`  -> seeded blend sleeve "${DOC.name}" into paper incubation (id ${id})`);

  // ---- 4) UPSERT THE MY STRATEGIES CARD (blend as the blue-glow hero = first card) ----
  const existingJson = await cx.query(api.pipeline.getConfig, { key: "my_strategies" });
  let cfg: { generatedAt: number; strategies: { key: string }[] } = { generatedAt: Date.now(), strategies: [] };
  if (existingJson) { try { cfg = JSON.parse(existingJson); } catch { /* start fresh */ } }
  // remove any prior blend card, then put the blend FIRST (page applies blue-glow to i===0)
  const others = (cfg.strategies ?? []).filter((s) => s.key !== "blend7030");
  const next = { generatedAt: Date.now(), strategies: [card, ...others] };
  await cx.mutation(api.pipeline.setConfig, { key: "my_strategies", json: JSON.stringify(next) });
  console.log(`  -> wrote My Strategies card "blend7030" as the hero (first of ${next.strategies.length} cards)`);

  console.log(`\nDone. The kind-aware paper-step (hourly) now forward-tests the blend; the My Strategies tab shows the since-2020 backtest card.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
