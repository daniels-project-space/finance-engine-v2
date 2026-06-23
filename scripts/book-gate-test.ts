// REVIEW ARTIFACT: run the book-marginal promotion gate against the EXISTING
// candidate pool and print the BOOK that forms. Read-only; deploys NOTHING.
//
// VALID OOS streams: re-runs the real gauntlet on each target candidate to
// collect its LIVE deployed-portfolio OOS return stream (report.portfolioOos,
// now carried on S4+ even when the standalone S5 hurdle fails). This is exactly
// the stream the live gate would see. (The persisted curves.port is only a
// downsampled DISPLAY curve — invalid for Sharpe/correlation.)
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { loadBars } from "../src/lib/data";
import { runGauntlet } from "../src/engine/gauntlet";
import { getAppConfig } from "../src/pipeline/process";
import { PPY, type Bars, type StrategyDoc } from "../src/engine/types";
import { type Stream, buildBook } from "../src/engine/book";
import { perSleeveSignificant, marginalAdmits, bookLevelGate } from "../src/engine/bookGate";

async function main() {
  const cx = new ConvexHttpClient(process.env.CONVEX_URL!);
  const cfg = await getAppConfig(cx);
  const N = Number(process.argv[2] ?? "30");

  // strongest S4-portfolio+ reachers by portOosSharpe (the sleeves the wrong gate threw away)
  const failed = await cx.query(api.candidates.listByStage, { stage: "failed", limit: 1000 }) as any[];
  const reachers = failed
    .filter((r: any) => { const f = r.failedStage ?? ""; return f === "S4-portfolio" || f.startsWith("S5") || f === "S6-sealed"; })
    .map((r: any) => { let m: any = {}; try { m = JSON.parse(r.metrics ?? "{}"); } catch {} return { r, portSharpe: Number(m.portOosSharpe ?? 0) }; })
    .filter((x) => x.portSharpe > 0)
    .sort((a, b) => b.portSharpe - a.portSharpe)
    .slice(0, N);

  // Pick the dominant tf cohort among the strongest reachers so the book is built
  // within ONE bar grid (1h and 4h streams don't share timestamps => can't ERC/
  // correlate cleanly across tf). Default to the tf of the strongest sleeves.
  const tfCounts: Record<string, number> = {};
  for (const { r } of reachers) { let d: any = {}; try { d = JSON.parse(r.dsl); } catch {} const tf = d.tf ?? "1h"; tfCounts[tf] = (tfCounts[tf] ?? 0) + 1; }
  const COHORT_TF = (Object.entries(tfCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "1h") as "1h" | "4h" | "1d";
  console.log(`tf cohort sizes: ${JSON.stringify(tfCounts)} -> building book on the "${COHORT_TF}" cohort`);
  console.log(`re-streaming the strongest "${COHORT_TF}" S4-portfolio+ sleeves (live gauntlet)...\n`);

  const ppy = PPY[COHORT_TF] ?? 8760;
  const sealTs = Date.parse(cfg.sealDate);
  const primary = await loadBars(cfg.primarySymbol, COHORT_TF);
  if (!primary) throw new Error("no primary bars for " + COHORT_TF);
  const others: Bars[] = [];
  for (const sym of cfg.universe) { if (sym === cfg.primarySymbol) continue; const b = await loadBars(sym, COHORT_TF); if (b && b.t.length > ppy * 1.7) others.push(b); }
  const altTf = COHORT_TF === "1h" ? "4h" : "1h"; const pAlt = await loadBars(cfg.primarySymbol, altTf); if (pAlt) others.push(pAlt);

  type Sleeve = { id: string; name: string; stream: { t: number[]; ret: number[] }; permP?: number; pbo?: number; portSharpe: number };
  const sleeves: Sleeve[] = [];
  for (const { r, portSharpe } of reachers) {
    let doc: StrategyDoc; try { doc = JSON.parse(r.dsl); } catch { continue; }
    if ((doc.tf ?? "1h") !== COHORT_TF) continue;
    try {
      const rep = runGauntlet({ doc, primary, others, sealTs, floors: cfg.floors, nTrialsTotal: 40,
        binding: { purgedWf: cfg.walkforward.purged, pbo: { bind: cfg.shadowRigor.pbo.bind, max: cfg.shadowRigor.pbo.max, blocks: cfg.shadowRigor.pboBlocks },
          regime: { bind: cfg.shadowRigor.regime.bind, minSharpe: cfg.shadowRigor.regime.minSharpe, minObs: cfg.shadowRigor.regime.minObs, maxPnlConcentration: cfg.shadowRigor.regime.maxPnlConcentration } } });
      if (rep.portfolioOos && rep.portfolioOos.ret.length >= 50) {
        sleeves.push({ id: r._id, name: r.name, stream: rep.portfolioOos, permP: rep.metrics.permutationP, pbo: rep.metrics.pbo, portSharpe });
        process.stdout.write(`  streamed ${r.name} (port OOS ${rep.portfolioOos.ret.length} bars, S4 sharpe ${(rep.metrics.portOosSharpe ?? 0).toFixed(2)}, died ${rep.failedStage ?? "passed"})\n`);
      } else {
        process.stdout.write(`  skip ${r.name} (no port stream; died ${rep.failedStage})\n`);
      }
    } catch (e) { process.stdout.write(`  err ${r.name}: ${e instanceof Error ? e.message.slice(0, 80) : e}\n`); }
  }
  console.log(`\n${sleeves.length} sleeves with live OOS streams\n`);

  // ===== (A) per-sleeve significance — RELAXED but REAL ======================
  const A_CFG = { minBootLo: 0, maxPermP: 0.05, maxPbo: 0.5, minDeflatedSharpe: 0.0 };
  console.log("=== (A) per-sleeve significance (bootCI.lo>0, deflated p5>=0, permP<=0.05, pbo<0.5) ===");
  const sig: Sleeve[] = [];
  for (const s of sleeves) {
    const r = perSleeveSignificant({ ret: Float64Array.from(s.stream.ret), ppy, nTrials: 40, permP: s.permP, pbo: s.pbo }, A_CFG);
    console.log(`  ${r.passes ? "PASS" : "kill"} ${s.name} standalone=${r.standaloneSharpe.toFixed(2)} bootLo=${r.bootLo.toFixed(2)} deflP5=${r.deflatedSharpe.toFixed(2)} permP=${s.permP?.toFixed(3) ?? "-"} pbo=${s.pbo?.toFixed(2) ?? "-"} ${r.reasons.length ? "(" + r.reasons.join("; ") + ")" : ""}`);
    if (r.passes) sig.push(s);
  }
  console.log(`\n(A) ${sig.length}/${sleeves.length} pass\n`);

  // ===== (B) marginal book admission (greedy best-first) =====================
  const B_CFG = { minMarginalSharpe: 0.05, maxCorr: 0.6 };
  const ranked = [...sig].sort((a, b) => b.portSharpe - a.portSharpe);
  const admitted: { sleeve: Sleeve; stream: Stream }[] = [];
  console.log("=== (B) marginal admission (lift >= +0.05 OR corr<0.6; reject near-dupes) ===");
  for (const s of ranked) {
    const cand: Stream = { id: s.id, t: s.stream.t, ret: Float64Array.from(s.stream.ret) };
    const res = marginalAdmits(cand, admitted.map((a) => a.stream), ppy, B_CFG);
    console.log(`  ${res.admits ? "ADMIT" : "skip "} ${s.name} | ${res.reason} | standalone=${res.marginal.standaloneSharpe.toFixed(2)} maxCorr=${res.marginal.maxCorr.toFixed(2)} newBook=${res.marginal.newBookSharpe.toFixed(2)}`);
    if (res.admits) admitted.push({ sleeve: s, stream: cand });
  }
  console.log(`\n(B) ${admitted.length} admitted\n`);

  // ===== (C) book-level gate ================================================
  const C_CFG = { minBookSharpe: 1.0, minBookDeflatedSharpe: 1.0, maxMeanAbsCorr: 0.5 };
  const streams = admitted.map((a) => a.stream);
  const gate = bookLevelGate(streams, ppy, admitted.length, C_CFG);
  console.log("=== (C) book-level gate (bookSharpe>=1.0, bookDeflatedP5>=1.0, meanAbsCorr<=0.5) ===");
  console.log(`  BOOK: ${gate.nMembers} sleeves | bookSharpe=${gate.bookSharpe.toFixed(2)} | bookDeflated(p5)=${gate.bookDeflatedSharpe.toFixed(2)} | divRatio=${gate.diversificationRatio.toFixed(2)} | meanAbsCorr=${gate.meanAbsCorr.toFixed(2)}`);
  console.log(`  PASSES book gate: ${gate.passes ? "YES" : "NO"} ${gate.reasons.length ? "(" + gate.reasons.join("; ") + ")" : ""}`);

  console.log("\n=== BOOK COMPOSITION ===\nname | ercWeight | riskContrib | standaloneSharpe");
  const bb = buildBook(streams, ppy);
  bb.members.forEach((m, i) => console.log(`  ${admitted[i].sleeve.name} | ${(m.weight * 100).toFixed(0)}% | ${(m.riskContrib * 100).toFixed(0)}% | ${m.standaloneSharpe.toFixed(2)}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
