// Real-candidate SHADOW-RIGOR readout. Pulls stored candidate docs from Convex
// (glad-poodle-88) and runs them through the new validation-honesty stats, then
// a batch Reality Check across the set. NO LLM / OAuth needed — only Convex
// (CONVEX_URL) + R2 (bar store). Read-only: writes NOTHING back to Convex.
//
//   Usage: npx tsx scripts/shadow-rigor-eval.ts [count]   (default 5)
//
// For each candidate we re-derive the deployment parameters exactly as the
// gauntlet does (re-tuning walk-forward -> median params), then compute:
//   PBO (CSCV over the tuner configs), purged+embargoed WF Sharpe,
//   parameter stability, regime-conditional Sharpes + PnL concentration.
// Finally White's Reality Check / SPA over all candidates' WF OOS streams.

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { loadBars } from "../src/lib/data";
import { walkForward, walkForwardPurged } from "../src/engine/walkforward";
import { medianParams, optsFor, maxIndicatorLookback } from "../src/engine/gauntlet";
import { computePbo, paramStability, suggestEmbargo, realityCheck } from "../src/engine/rigor";
import { tuneWithConfigs, adaptiveTrials } from "../src/engine/tune";
import { classifyRegimes, regimeBreakdown } from "../src/engine/regime";
import { indexOfTs } from "../src/engine/backtest";
import { PPY, type Bars, type StrategyDoc } from "../src/engine/types";

async function main() {
  const count = Number(process.argv[2] ?? "5");
  const url = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL missing");
  const cx = new ConvexHttpClient(url);
  const sealTs = Date.parse("2026-02-01");

  // pick the top stored candidates by composite (the most interesting ones)
  const board = await cx.query(api.candidates.tournament, { limit: 40 });
  const picks = board.filter((r) => r.composite !== undefined).slice(0, count);
  console.log(`Evaluating ${picks.length} stored candidates (shadow-rigor, read-only)\n`);

  // bar cache
  const barCache = new Map<string, Bars | null>();
  const getBars = async (sym: string, tf: string) => {
    const key = `${sym}@${tf}`;
    if (!barCache.has(key)) barCache.set(key, await loadBars(sym, tf));
    return barCache.get(key) ?? null;
  };

  const rcCollector: { name: string; ret: number[] }[] = [];

  for (const [i, row] of picks.entries()) {
    const doc = JSON.parse(row.dsl) as StrategyDoc;
    const tf = doc.tf ?? "1h";
    const ppy = PPY[tf] ?? 8760;
    const primary = await getBars("BTC/USDT", tf);
    if (!primary || primary.t.length < ppy * 2) { console.log(`${i + 1}. ${doc.name} — no ${tf} bars, skip`); continue; }
    const opts = optsFor("BTC/USDT", tf);
    const sealI = indexOfTs(primary.t, sealTs);
    const devEndI = sealI - 1;

    try {
      const t0 = Date.now();
      // deployment params via re-tuning WF -> median (the gauntlet's S5 params)
      const wf = walkForward(doc, primary, opts, { trainMonths: 12, stepMonths: tf === "1h" ? 1 : 2, tuneTrials: 30, endTs: sealTs });
      const finalParams = wf.windows.length >= 4 ? medianParams(doc, wf) : Object.fromEntries(Object.entries(doc.params ?? {}).map(([k, p]) => [k, p.default]));

      // F1: PBO over the tuner's real configs (decided on the train slice)
      const trainEnd = Math.floor(devEndI * 0.7);
      const tuned = tuneWithConfigs(doc, primary, opts, { startI: 1, endI: trainEnd }, adaptiveTrials(doc, 40), 11);
      const configs = dedupe(tuned.configs.map((c) => c.params));
      const pbo = configs.length >= 4
        ? computePbo(doc, primary, opts, configs, { startI: 1, endI: devEndI }, { nBlocks: 10, proxy: false })
        : computePbo(doc, primary, opts, proxyGrid(doc, finalParams), { startI: 1, endI: devEndI }, { nBlocks: 10, proxy: true });

      // F1b: purged + embargoed WF Sharpe
      const lookback = maxIndicatorLookback(doc, finalParams);
      const embargo = suggestEmbargo(devEndI, lookback);
      const wfp = walkForwardPurged(doc, primary, opts, { trainMonths: 12, stepMonths: tf === "1h" ? 1 : 2, tuneTrials: 30, endTs: sealTs, purgeWindow: lookback, embargo });

      // F2: parameter stability
      const stab = paramStability(doc, primary, opts, finalParams, { startI: 1, endI: devEndI });

      // F4: regime breakdown on the WF pooled OOS returns
      const portT = Array.from(wf.pooledT);
      const portRet = Array.from(wf.pooledRet);
      const cls = classifyRegimes(primary.c, { volWindow: 48, trendWindow: 96 });
      const labels = new Int8Array(portT.length).fill(-1);
      for (let j = 0; j < portT.length; j++) {
        const idx = indexOfTs(primary.t, portT[j]);
        if (idx < primary.t.length && primary.t[idx] === portT[j]) labels[j] = cls.labels[idx];
      }
      const rb = regimeBreakdown(portRet, labels, ppy, 30);

      if (portRet.length >= 30) rcCollector.push({ name: doc.name, ret: portRet });

      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      const regimeStr = Object.entries(rb.sharpeByName).map(([k, v]) => `${k.replace("vol", "")}=${v.toFixed(2)}`).join(" ");
      console.log(`${i + 1}. ${doc.name}  [tf=${tf} comp=${(row.composite ?? 0).toFixed(2)} died@${row.failedStage}]  (${secs}s)`);
      console.log(`     PBO=${pbo.pbo.toFixed(2)}${pbo.proxy ? "(proxy)" : ""}  wfSharpe=${wf.pooledSharpe.toFixed(2)} -> wfPurged=${wfp.pooledSharpe.toFixed(2)}  stability=${stab.stability.toFixed(2)} (frac=${stab.neighborFrac.toFixed(2)} smooth=${stab.smoothness.toFixed(2)})`);
      console.log(`     regimeMinSharpe=${Number.isFinite(rb.minWellPopulatedSharpe) ? rb.minWellPopulatedSharpe.toFixed(2) : "n/a"}  pnlConcentration=${rb.pnlConcentration ? `YES(${rb.dominant?.name} ${((rb.dominant?.share ?? 0) * 100).toFixed(0)}%)` : "no"}`);
      console.log(`     regimes: ${regimeStr || "(none well-populated)"}\n`);
    } catch (e) {
      console.log(`${i + 1}. ${doc.name} — ERROR ${e instanceof Error ? e.message.slice(0, 120) : e}\n`);
    }
  }

  // F3: batch Reality Check across the evaluated set
  if (rcCollector.length >= 2) {
    const rc = realityCheck(rcCollector.map((c) => c.ret), { nReps: 1000 });
    console.log("===== Batch Reality Check (White RC / Hansen SPA) over the set =====");
    console.log(`candidates=${rc.nCandidates}  best="${rcCollector[rc.bestIndex]?.name}"  bestStat=${rc.bestStat.toFixed(2)}`);
    console.log(`family-wise RC p=${rc.bestRcP.toFixed(3)}   SPA p=${rc.bestSpaP.toFixed(3)}   (small p => the best survives multiple-testing)`);
    console.log("per-candidate family-wise p:");
    rcCollector.forEach((c, idx) => console.log(`   ${c.name}: p=${rc.perCandidateP[idx].toFixed(3)}`));
  } else {
    console.log("Batch Reality Check skipped (need >=2 candidates with OOS streams)");
  }
}

function dedupe(configs: Record<string, number>[]): Record<string, number>[] {
  const seen = new Set<string>(); const out: Record<string, number>[] = [];
  for (const c of configs) {
    const key = Object.keys(c).sort().map((k) => `${k}:${c[k].toFixed(4)}`).join("|");
    if (!seen.has(key)) { seen.add(key); out.push(c); }
  }
  return out;
}
function proxyGrid(doc: StrategyDoc, base: Record<string, number>): Record<string, number>[] {
  const keys = Object.keys(doc.params ?? {}).filter((k) => Number.isFinite(base[k]));
  const grid: Record<string, number>[] = [{ ...base }];
  for (const k of keys) for (const d of [-0.2, -0.1, 0.1, 0.2]) {
    const spec = doc.params[k]; let v = base[k] * (1 + d);
    v = Math.min(spec.max, Math.max(spec.min, v)); if (spec.int) v = Math.round(v);
    if (v !== base[k]) grid.push({ ...base, [k]: v });
  }
  return dedupe(grid);
}

main().catch((e) => { console.error(e); process.exit(1); });
