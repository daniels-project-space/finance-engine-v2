// Seed the 1.5x AGGRESSIVE leveraged trend sleeves onto PAPER, head-to-head with
// the 1x trendbeta sleeves. Long 1.5x BTC/ETH/SOL when close>SMA(win), else flat.
//
// HONEST STATUS: like the 1x, the 1.5x sleeves do NOT clear the strict bootstrap-CI>0
// battery (WF Sharpe ~0.78, identical to 1x — leverage scales return AND drawdown,
// it does NOT improve robustness; bootLo ~-0.30). Routed via the FORWARD-PAPER path
// with the explicit "didn't pass battery + AGGRESSIVE 1.5x" tag. Real-money bar
// unchanged. Funding scales x1.5; liquidation distance ~-66% intrabar (modeled).

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { loadBars } from "../src/lib/data";
import { buildTrendDaily, walkForwardTrend, backtestTrend, hodlStream, type TrendBetaDoc } from "../src/engine/trendbeta";
import { trendBetaHash, trendBetaFamilyHash } from "../src/engine/trendbetaGen";
import type { Id } from "../convex/_generated/dataModel";

const COMMIT = process.argv.includes("--commit");
const DAY = 864e5;
const cx = new ConvexHttpClient(process.env.CONVEX_URL!);

function downsample(t: number[], eq: number[], n = 300) {
  if (t.length <= n) return { t, eq };
  const step = t.length / n; const ot: number[] = [], oe: number[] = [];
  for (let i = 0; i < n; i++) { const idx = Math.min(t.length - 1, Math.floor(i * step)); ot.push(t[idx]); oe.push(eq[idx]); }
  ot.push(t[t.length - 1]); oe.push(eq[eq.length - 1]); return { t: ot, eq: oe };
}
function stat(eq: number[], t: number[]) {
  const tot = eq[eq.length - 1] - 1, y = Math.max(0.01, (t[t.length - 1] - t[0]) / (365 * DAY));
  const cagr = eq[eq.length - 1] > 0 ? Math.pow(eq[eq.length - 1], 1 / y) - 1 : -1;
  let pk = -Infinity, dd = 0; for (const v of eq) { pk = Math.max(pk, v); const d = v / pk - 1; if (d < dd) dd = d; }
  return { tot, cagr, maxDD: dd, calmar: dd < 0 ? cagr / Math.abs(dd) : 0 };
}

async function main() {
  const PICKS = [{ symbol: "BTC/USDT" }, { symbol: "ETH/USDT" }, { symbol: "SOL/USDT" }];
  const LEV = 1.5, SMA = 200;
  const out: { doc: TrendBetaDoc; wfSharpe: number; wfMaxDD: number; full: { t: number[]; eq: number[] }; hodlFull: { t: number[]; eq: number[] }; oos: { t: number[]; eq: number[] }; ts: ReturnType<typeof stat>; hs: ReturnType<typeof stat> }[] = [];

  for (const { symbol } of PICKS) {
    const bars = await loadBars(symbol, "1d"); if (!bars) continue;
    const S = buildTrendDaily(bars);
    const doc: TrendBetaDoc = {
      name: `tb_${symbol.split("/")[0].toLowerCase()}_sma${SMA}_1p5x`, kind: "trendbeta",
      hypothesis: `AGGRESSIVE 1.5x leveraged risk-managed beta: hold ${symbol} at 1.5x when price is above its ${SMA}-day SMA, else cash. Higher return AND higher drawdown than the 1x variant; funding scales x1.5; flash-crash/liquidation tail risk (liq ~-66% intrabar). Long-flat (0 or 1.5x), point-in-time SMA.`,
      symbol, tf: "1d", smaWin: SMA,
      params: { smaWin: { min: 80, max: 300, default: SMA, int: true } },
      risk: { volTargetAnnual: 0.8, maxLeverage: LEV },
    };
    const wf = walkForwardTrend(doc, S, {});
    const bt = backtestTrend(doc, S, { smaWin: SMA }, { startI: 250 });
    const tT: number[] = [], tE: number[] = []; let teq = 1; const hT: number[] = [], hE: number[] = []; let heq = 1;
    for (let i = 251; i < S.t.length; i++) { teq *= 1 + bt.ret[i]; tT.push(S.t[i]); tE.push(teq); heq *= S.close[i] / S.close[i - 1]; hT.push(S.t[i]); hE.push(heq); }
    const eq: number[] = []; let acc = 1; for (let i = 0; i < wf.pooledRet.length; i++) { acc *= 1 + wf.pooledRet[i]; eq.push(acc); }
    out.push({ doc, wfSharpe: wf.pooledSharpe, wfMaxDD: wf.pooledMaxDD, full: downsample(tT, tE), hodlFull: downsample(hT, hE), oos: { t: Array.from(wf.pooledT, Number), eq }, ts: stat(tE, tT), hs: stat(hE, hT) });
  }

  console.log("\n1.5x AGGRESSIVE trend sleeves to seed — full-sample vs SPOT BTC/coin HODL:\n");
  console.log(`${"sleeve".padEnd(24)} ${"WF-Sh".padStart(6)} ${"total".padStart(7)} ${"maxDD".padStart(7)} ${"Calmar".padStart(6)}   vs HODL ${"total".padStart(7)} ${"maxDD".padStart(7)}`);
  for (const o of out) console.log(`${o.doc.name.padEnd(24)} ${o.wfSharpe.toFixed(2).padStart(6)} ${(o.ts.tot * 100).toFixed(0).padStart(6)}% ${(o.ts.maxDD * 100).toFixed(0).padStart(6)}% ${o.ts.calmar.toFixed(2).padStart(6)}          ${(o.hs.tot * 100).toFixed(0).padStart(6)}% ${(o.hs.maxDD * 100).toFixed(0).padStart(6)}%`);

  if (!COMMIT) { console.log("\n(dry run — pass --commit)"); return; }

  for (const o of out) {
    const hash = trendBetaHash(o.doc), fam = trendBetaFamilyHash(o.doc);
    if (await cx.query(api.candidates.hashExists, { hash })) { console.log(`  ${o.doc.name} exists, skipping`); continue; }
    const metrics = {
      wfPooledSharpe: o.wfSharpe, portOosSharpe: o.wfSharpe, wfMaxDD: o.wfMaxDD,
      fullTotal: o.ts.tot, fullCagr: o.ts.cagr, fullMaxDD: o.ts.maxDD, fullCalmar: o.ts.calmar,
      trendCagr: o.ts.cagr, trendMaxDD: o.ts.maxDD, trendCalmar: o.ts.calmar,
      hodlTotal: o.hs.tot, hodlCagr: o.hs.cagr, hodlMaxDD: o.hs.maxDD, hodlCalmar: o.hs.calmar,
      forwardPaper: 1, forwardPaperSeed: 1, aggressive: 1, leverage: 1.5,
    };
    const created = await cx.mutation(api.candidates.create, { name: o.doc.name, source: "trendbeta", dsl: JSON.stringify(o.doc), hash, familyHash: fam, hypothesis: o.doc.hypothesis, premium: "trendbeta" }) as { duplicate: boolean; id: string };
    const id = created.id as Id<"candidates">;
    await cx.mutation(api.paper.ensureAccount, { candidateId: id, startEquity: 10_000 });
    await cx.mutation(api.candidates.updateStage, {
      id, stage: "incubating", metrics: JSON.stringify(metrics), bestParams: JSON.stringify({ smaWin: SMA }),
      curves: JSON.stringify({ wf: { t: o.oos.t, eq: o.oos.eq }, full: o.full, hodlFull: o.hodlFull }),
      composite: o.wfSharpe, incubationStartedAt: Date.now(),
    });
    await cx.mutation(api.pipeline.addLesson, { source: "trendbeta", candidateId: id, text: `FORWARD-PAPER SEED (1.5x AGGRESSIVE): "${o.doc.name}" leveraged trend (WF Sharpe ${o.wfSharpe.toFixed(2)}, full total ${(o.ts.tot * 100).toFixed(0)}% / maxDD ${(o.ts.maxDD * 100).toFixed(0)}% vs 1x ~136%/-32% vs HODL ${(o.hs.tot * 100).toFixed(0)}%/${(o.hs.maxDD * 100).toFixed(0)}%). Did NOT pass the strict bootstrap battery (leverage scales return+drawdown, not robustness). Forward-testing head-to-head with the 1x to judge if 1.5x earns its risk. Funding x1.5; liq ~-66% intrabar. Real-money bar unchanged.` });
    console.log(`  -> seeded ${o.doc.name} (1.5x aggressive, paper)`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
