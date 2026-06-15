// Real-candidate WAVE-2 SHADOW readout. Pulls stored candidate docs from Convex
// (glad-poodle-88) + live R2 bars, then computes Feature B (capacity / impact)
// per candidate and Feature A (ERC diversification book) across the set. NO LLM
// / OAuth needed. Read-only: writes NOTHING back to Convex.
//
//   Usage: npx tsx scripts/book-capacity-eval.ts [count]   (default 5)
//
// Deployment params are re-derived exactly as the gauntlet does (re-tuning
// walk-forward -> median params). Capacity uses the bar quote-volume proxy
// (ADV_notional = baseVolume * close). The book is built from each candidate's
// WF pooled OOS return stream (the deployed-portfolio proxy on the primary).

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { loadBars } from "../src/lib/data";
import { walkForward } from "../src/engine/walkforward";
import { medianParams, optsFor } from "../src/engine/gauntlet";
import { computeCapacity } from "../src/engine/capacity";
import { buildBook, marginalContribution, bookQualifies, type Stream } from "../src/engine/book";
import { indexOfTs } from "../src/engine/backtest";
import { PPY, type Bars, type StrategyDoc } from "../src/engine/types";

function fmtUsd(x: number): string {
  if (!Number.isFinite(x)) return "n/a";
  if (x >= 1e9) return `$${(x / 1e9).toFixed(1)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(0)}k`;
  return `$${x.toFixed(0)}`;
}

async function main() {
  const count = Number(process.argv[2] ?? "5");
  const url = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL missing");
  const cx = new ConvexHttpClient(url);
  const sealTs = Date.parse("2026-02-01");

  const board = await cx.query(api.candidates.tournament, { limit: 40 });
  const picks = board.filter((r) => r.composite !== undefined).slice(0, count);
  console.log(`Evaluating ${picks.length} stored candidates (WAVE-2 capacity + book, read-only)\n`);

  const barCache = new Map<string, Bars | null>();
  const getBars = async (sym: string, tf: string) => {
    const key = `${sym}@${tf}`;
    if (!barCache.has(key)) barCache.set(key, await loadBars(sym, tf));
    return barCache.get(key) ?? null;
  };

  const bookStreams: Stream[] = [];
  const labels: string[] = [];

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
      const wf = walkForward(doc, primary, opts, { trainMonths: 12, stepMonths: tf === "1h" ? 1 : 2, tuneTrials: 30, endTs: sealTs });
      const finalParams = wf.windows.length >= 4 ? medianParams(doc, wf) : Object.fromEntries(Object.entries(doc.params ?? {}).map(([k, p]) => [k, p.default]));

      // Feature B: capacity / square-root impact on the primary with deploy params
      const cap = computeCapacity(doc, primary, finalParams, opts, { startI: 1, endI: devEndI }, { k: 0.7, refAumUsd: 100_000 });

      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`${i + 1}. ${doc.name}  [tf=${tf} comp=${(row.composite ?? 0).toFixed(2)} died@${row.failedStage}]  (${secs}s)`);
      console.log(`     capacityUsd=${fmtUsd(cap.capacityUsd)}  impactAdjustedSharpe@100k=${cap.impactAdjustedSharpe.toFixed(2)}  frictionless=${cap.frictionlessSharpe.toFixed(2)}  turnover/yr=${cap.turnoverPerYear.toFixed(0)}  meanADV=${fmtUsd(cap.meanAdvNotionalUsd)}/bar  floor=${cap.floor.toFixed(2)}${cap.note ? `  [${cap.note}]` : ""}`);
      // a couple of curve points for intuition
      const pts = cap.curve.filter((p) => [1e5, 1e6, 1e7].includes(p.aumUsd));
      console.log(`     curve: ${pts.map((p) => `${fmtUsd(p.aumUsd)}->S${p.netSharpe.toFixed(2)}(part ${(p.meanParticipation * 100).toFixed(2)}%)`).join("  ")}\n`);

      // Feature A: collect the WF pooled OOS stream for the cross-set book
      if (wf.pooledRet.length >= 30) {
        bookStreams.push({ id: row._id, t: Array.from(wf.pooledT), ret: Array.from(wf.pooledRet) });
        labels.push(doc.name);
      }
    } catch (e) {
      console.log(`${i + 1}. ${doc.name} — ERROR ${e instanceof Error ? e.message.slice(0, 120) : e}\n`);
    }
  }

  // Feature A: build the diversification book over the evaluated set
  console.log("===== Feature A: ERC diversification book over the evaluated set =====");
  if (bookStreams.length >= 1) {
    const ppy = 8760; // book stats annualized on an hourly convention for comparability
    const book = buildBook(bookStreams, ppy);
    console.log(`members=${book.members.length}  bookSharpe=${book.stats.sharpe.toFixed(2)}  vol=${(book.stats.vol * 100).toFixed(1)}%  maxDD=${(book.stats.maxDD * 100).toFixed(1)}%  meanAbsCorr=${book.meanAbsCorr.toFixed(2)}  alignedBars=${book.nBars}`);
    console.log("ERC weights + standalone Sharpe per member:");
    book.members.forEach((m, idx) => console.log(`   ${labels[idx]}: w=${(m.weight * 100).toFixed(1)}%  riskContrib=${(m.riskContrib * 100).toFixed(1)}%  standaloneSharpe=${m.standaloneSharpe.toFixed(2)}`));
    // correlation matrix (compact)
    if (book.correlation.length >= 2) {
      console.log("correlation matrix:");
      console.log("       " + labels.map((l) => l.slice(0, 7).padStart(8)).join(""));
      book.correlation.forEach((rrow, r) => {
        console.log(`   ${labels[r].slice(0, 6).padEnd(6)}` + rrow.map((c) => c.toFixed(2).padStart(8)).join(""));
      });
    }
    // marginal contribution of each member (leave-one-out)
    console.log("leave-one-out marginal contribution:");
    bookStreams.forEach((s, idx) => {
      const others = bookStreams.filter((_, j) => j !== idx);
      const mc = marginalContribution(s, others, ppy);
      const q = bookQualifies(mc, { minMarginalSharpe: 0.1, maxCorr: 0.6 });
      console.log(`   ${labels[idx]}: marginalSharpe=${mc.marginalSharpe.toFixed(2)}  maxCorr=${mc.maxCorr.toFixed(2)}  standalone=${mc.standaloneSharpe.toFixed(2)}  qualifies=${q ? "YES" : "no"}`);
    });
  } else {
    console.log("Book skipped (need >=1 candidate with an OOS stream)");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
