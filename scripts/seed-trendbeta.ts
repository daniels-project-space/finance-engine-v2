// Seed the best TREND-BETA sleeves onto PAPER for forward-testing.
//
// HONEST STATUS (measured, not assumed): the trend-filter sleeves do NOT clear the
// strict per-sleeve bootstrap-CI>0 battery (Sharpe ~0.7 over ~4.5y of lumpy daily
// long-flat returns => bootstrap CI lower bound is slightly negative, bootLo ~-0.17
// for BTC SMA200). They ARE materially more robust than BTC HODL itself (HODL
// bootLo ~-0.60) and have the session's best RISK profile (maxDD ~-29% vs HODL
// -77%, Calmar ~0.7 vs ~0). So we route them via the FORWARD-PAPER path (simulated,
// no real money) — the same mechanism for "genuinely-risk-improving but not strict-
// battery-clearing" sleeves — to build a live forward track record. Real-money
// promotion stays strict. We do NOT claim they passed the battery.
//
// Creates trend-beta candidate docs (BTC + ETH + SOL), records their WF stats +
// vs-HODL comparison, and routes them to incubating. Run with --commit.

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { loadBars } from "../src/lib/data";
import { buildTrendDaily, walkForwardTrend, backtestTrend, hodlStream, type TrendBetaDoc } from "../src/engine/trendbeta";
import { trendBetaHash, trendBetaFamilyHash } from "../src/engine/trendbetaGen";
import type { Id } from "../convex/_generated/dataModel";

const COMMIT = process.argv.includes("--commit");
const cx = new ConvexHttpClient(process.env.CONVEX_URL!);

function metricsOf(ret: Float64Array, startI: number) {
  const r: number[] = []; for (let i = startI; i < ret.length; i++) if (Number.isFinite(ret[i])) r.push(ret[i]);
  let eq = 1, peak = 1, maxDD = 0; for (const x of r) { eq *= 1 + x; if (eq > peak) peak = eq; const dd = eq / peak - 1; if (dd < maxDD) maxDD = dd; }
  const mean = r.reduce((a, b) => a + b, 0) / Math.max(1, r.length);
  const sd = Math.sqrt(Math.max(0, r.reduce((a, b) => a + b * b, 0) / Math.max(1, r.length) - mean * mean));
  const years = r.length / 365;
  const cagr = eq > 0 ? Math.pow(eq, 1 / Math.max(0.01, years)) - 1 : -1;
  const sharpe = sd > 1e-12 ? (mean / sd) * Math.sqrt(365) : 0;
  return { cagr, maxDD, sharpe, calmar: maxDD < 0 ? cagr / Math.abs(maxDD) : 0, finalMult: eq };
}

async function main() {
  // BTC the strongest; ETH/SOL for the cross-coin diversified trend family.
  const PICKS: { symbol: string; smaWin: number }[] = [
    { symbol: "BTC/USDT", smaWin: 200 },
    { symbol: "ETH/USDT", smaWin: 200 },
    { symbol: "SOL/USDT", smaWin: 200 },
  ];
  const toSeed: { doc: TrendBetaDoc; wfSharpe: number; wfMaxDD: number; oos: { t: number[]; eq: number[] }; trend: ReturnType<typeof metricsOf>; hodl: ReturnType<typeof metricsOf> }[] = [];

  for (const { symbol, smaWin } of PICKS) {
    const bars = await loadBars(symbol, "1d"); if (!bars) { console.log(symbol, "no bars"); continue; }
    const S = buildTrendDaily(bars);
    const doc: TrendBetaDoc = {
      name: `tb_${symbol.split("/")[0].toLowerCase()}_sma${smaWin}_seed`, kind: "trendbeta",
      hypothesis: `Risk-managed long beta: hold ${symbol} only when price is above its ${smaWin}-day SMA, else cash. Captures the up-trend, sits out deep bears. Long-flat, point-in-time SMA. Forward-paper (did not clear the strict bootstrap battery; strongest RISK profile vs HODL).`,
      symbol, tf: "1d", smaWin,
      params: { smaWin: { min: 80, max: 300, default: smaWin, int: true } },
      risk: { volTargetAnnual: 0.8, maxLeverage: 1 },
    };
    const wf = walkForwardTrend(doc, S, {});
    // full-sample fixed-SMA trend vs HODL (for the headline vs-HODL stats)
    const bt = backtestTrend(doc, S, { smaWin }, { startI: smaWin + 1 });
    const trend = metricsOf(bt.ret, smaWin + 2);
    const hodl = metricsOf(hodlStream(S, smaWin), smaWin + 2);
    // OOS equity curve from the WF stream (what gets persisted/charted)
    const eq: number[] = []; let acc = 1; for (let i = 0; i < wf.pooledRet.length; i++) { acc *= 1 + wf.pooledRet[i]; eq.push(acc); }
    toSeed.push({ doc, wfSharpe: wf.pooledSharpe, wfMaxDD: wf.pooledMaxDD, oos: { t: Array.from(wf.pooledT, Number), eq }, trend, hodl });
  }

  console.log("\nTREND-BETA sleeves to seed (forward-paper) — vs BTC HODL on full 4.5y:\n");
  console.log(`${"sleeve".padEnd(22)} ${"WF-Sharpe".padStart(9)} ${"CAGR".padStart(6)} ${"maxDD".padStart(7)} ${"Calmar".padStart(6)}  vs HODL: ${"CAGR".padStart(6)} ${"maxDD".padStart(7)} ${"Calmar".padStart(6)}`);
  for (const s of toSeed) {
    console.log(`${s.doc.name.padEnd(22)} ${s.wfSharpe.toFixed(2).padStart(9)} ${(s.trend.cagr * 100).toFixed(0).padStart(5)}% ${(s.trend.maxDD * 100).toFixed(0).padStart(6)}% ${s.trend.calmar.toFixed(2).padStart(6)}           ${(s.hodl.cagr * 100).toFixed(0).padStart(5)}% ${(s.hodl.maxDD * 100).toFixed(0).padStart(6)}% ${s.hodl.calmar.toFixed(2).padStart(6)}`);
  }

  if (!COMMIT) { console.log("\n(dry run — pass --commit to create + seed these trend sleeves)"); return; }

  for (const s of toSeed) {
    const hash = trendBetaHash(s.doc), fam = trendBetaFamilyHash(s.doc);
    // skip if this exact hash already exists
    const exists = await cx.query(api.candidates.hashExists, { hash });
    if (exists) { console.log(`  ${s.doc.name} already exists, skipping`); continue; }
    const metrics = {
      wfPooledSharpe: s.wfSharpe, portOosSharpe: s.wfSharpe, wfMaxDD: s.wfMaxDD, portMaxDD: s.wfMaxDD,
      trendCagr: s.trend.cagr, trendMaxDD: s.trend.maxDD, trendCalmar: s.trend.calmar,
      hodlCagr: s.hodl.cagr, hodlMaxDD: s.hodl.maxDD, hodlCalmar: s.hodl.calmar,
      forwardPaper: 1, forwardPaperSeed: 1,
    };
    const created = await cx.mutation(api.candidates.create, {
      name: s.doc.name, source: "trendbeta", dsl: JSON.stringify(s.doc), hash, familyHash: fam,
      hypothesis: s.doc.hypothesis, premium: "trendbeta",
    }) as { duplicate: boolean; id: string };
    const id = created.id as Id<"candidates">;
    await cx.mutation(api.paper.ensureAccount, { candidateId: id, startEquity: 10_000 });
    await cx.mutation(api.candidates.updateStage, {
      id, stage: "incubating",
      metrics: JSON.stringify(metrics), bestParams: JSON.stringify({ smaWin: s.doc.smaWin }),
      curves: JSON.stringify({ wf: { t: s.oos.t, eq: s.oos.eq } }),
      composite: s.wfSharpe, incubationStartedAt: Date.now(),
    });
    await cx.mutation(api.pipeline.addLesson, {
      source: "trendbeta", candidateId: id,
      text: `TREND-BETA FORWARD-PAPER: "${s.doc.name}" risk-managed long-beta (WF Sharpe ${s.wfSharpe.toFixed(2)}, maxDD ${(s.trend.maxDD * 100).toFixed(0)}% vs HODL ${(s.hodl.maxDD * 100).toFixed(0)}%, Calmar ${s.trend.calmar.toFixed(2)} vs HODL ${s.hodl.calmar.toFixed(2)}). Did NOT clear the strict bootstrap-CI battery (lumpy long-flat stream) but is far more robust than HODL — forward-testing on PAPER to validate the "safer than HODL" thesis live. Real-money bar unchanged.`,
    });
    console.log(`  -> seeded ${s.doc.name} (paper)`);
  }
  console.log(`\nSeeded ${toSeed.length} trend-beta sleeves to paper. The kind-aware paper-step will forward-test them.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
