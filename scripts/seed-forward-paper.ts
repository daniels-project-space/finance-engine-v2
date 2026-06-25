// ONE-TIME SEED: route the strongest genuinely-honest sleeves across families
// into PAPER incubation NOW, so forward-testing starts today. Uses the REAL
// significance battery (perSleeveSignificant) on each candidate's stored OOS
// equity stream — admits only those that genuinely pass (bootstrap-CI-lo > 0 +
// deflated(p5) >= floor + perm/PBO when available). Noise/overfit is rejected.
// Diversified: dedupe by family, cap the set, prefer low cross-correlation.
//
// PAPER = simulated. This does NOT touch the real-money bar.
//
// Run: CONVEX_URL=... npx tsx scripts/seed-forward-paper.ts [--commit]

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { perSleeveSignificant } from "../src/engine/bookGate";
import type { Id } from "../convex/_generated/dataModel";

const COMMIT = process.argv.includes("--commit");
const cx = new ConvexHttpClient(process.env.CONVEX_URL!);

type Curve = { t: number[]; eq: number[] };
function returnsFromCurve(c?: Curve): { ret: Float64Array; t: number[] } | null {
  if (!c?.eq?.length || c.eq.length < 30) return null;
  const ret: number[] = [], t: number[] = [];
  for (let i = 1; i < c.eq.length; i++) {
    const r = c.eq[i] / c.eq[i - 1] - 1;
    if (Number.isFinite(r)) { ret.push(r); t.push(c.t[i] ?? i); }
  }
  return ret.length > 20 ? { ret: Float64Array.from(ret), t } : null;
}
function familyOf(s: string): string {
  return s === "xsection" ? "xsection" : s === "ivsleeve" ? "ivsleeve" : s === "onchain" ? "onchain" : "dsl";
}
// bars/yr for the candidate's stored curve — the OOS curves are bar-spaced; we
// approximate ppy from the median spacing of its timestamps (4h => 2190, 1d => 365).
function ppyFromT(t: number[]): number {
  if (t.length < 3) return 2190;
  const dt: number[] = [];
  for (let i = 1; i < Math.min(t.length, 50); i++) { const d = t[i] - t[i - 1]; if (d > 0) dt.push(d); }
  dt.sort((a, b) => a - b);
  const med = dt[Math.floor(dt.length / 2)] || 4 * 3600_000;
  return Math.round((365 * 86400_000) / med);
}

async function main() {
  const all = await cx.query(api.candidates.recent, { limit: 500 }) as Array<{ _id: string; name: string; source: string; stage: string; failedStage?: string; metrics?: string; curves?: string; bestParams?: string; hypothesis: string; familyHash: string }>;

  type Cand = { id: string; name: string; family: string; src: string; oos: number; ret: Float64Array; t: number[]; ppy: number; permP?: number; pbo?: number; res: ReturnType<typeof perSleeveSignificant> };
  const passers: Cand[] = [];

  for (const c of all) {
    if (c.stage === "incubating" || c.stage === "eligible" || c.stage === "champion") continue; // already in paper
    if (!c.metrics || !c.curves) continue;
    let m: Record<string, number>, cv: { port?: Curve; wf?: Curve };
    try { m = JSON.parse(c.metrics); cv = JSON.parse(c.curves); } catch { continue; }
    const oos = m.portOosSharpe ?? m.wfPooledSharpe;
    if (oos === undefined || !Number.isFinite(oos) || oos <= 0) continue;
    const derived = returnsFromCurve(cv.port ?? cv.wf);
    if (!derived) continue;
    const ppy = ppyFromT(derived.t);
    // THE REAL BATTERY — bootstrap CI lo > 0 + deflated(p5) >= 0, plus perm/PBO if present.
    const res = perSleeveSignificant(
      { ret: derived.ret, ppy, nTrials: 40, permP: m.permutationP, pbo: m.pbo },
      { minBootLo: 0, minDeflatedSharpe: 0, maxPermP: 0.05, maxPbo: 0.5 },
    );
    if (!res.passes) continue;
    passers.push({ id: c._id, name: c.name, family: familyOf(c.source), src: c.source, oos, ret: derived.ret, t: derived.t, ppy, permP: m.permutationP, pbo: m.pbo, res });
  }

  // DIVERSIFIED selection: the whole point is a diversified paper book, not 6
  // correlated breakouts. Take the best passer per family first (the orthogonal
  // alpha sources), then fill remaining slots with the next-best that are NOT
  // too correlated with what's already chosen (Pearson on overlapping returns).
  passers.sort((a, b) => b.oos - a.oos);
  const corr = (a: Float64Array, b: Float64Array): number => {
    const n = Math.min(a.length, b.length); if (n < 20) return 0;
    const A = a.subarray(a.length - n), B = b.subarray(b.length - n);
    let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += A[i]; mb += B[i]; } ma /= n; mb /= n;
    let sab = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { const da = A[i] - ma, db = B[i] - mb; sab += da * db; sa += da * da; sb += db * db; }
    return sa > 0 && sb > 0 ? sab / Math.sqrt(sa * sb) : 0;
  };
  const MAXCORR = 0.7;
  const chosen: Cand[] = [];
  const famSeen = new Set<string>();
  for (const c of passers) { if (!famSeen.has(c.family)) { chosen.push(c); famSeen.add(c.family); } }   // one best per family = the diversifiers
  for (const c of passers) {
    if (chosen.length >= 8) break;
    if (chosen.includes(c)) continue;
    const maxC = Math.max(0, ...chosen.map((x) => Math.abs(corr(c.ret, x.ret))));
    if (maxC < MAXCORR) chosen.push(c); // only add genuinely-additive (uncorrelated) extras
  }

  console.log(`\n${passers.length} candidates PASS the real significance battery. Seeding a diversified ${chosen.length}:\n`);
  for (const c of chosen) {
    console.log(`  [${c.family}] ${c.name}  OOS=${c.oos.toFixed(2)}  bootLo=${c.res.bootLo.toFixed(2)}  deflated(p5)=${c.res.deflatedSharpe.toFixed(2)}  ppy~${c.ppy}  ${c.permP !== undefined ? "permP=" + c.permP.toFixed(3) : ""} ${c.pbo !== undefined ? "pbo=" + c.pbo.toFixed(2) : ""}`);
  }

  if (!COMMIT) { console.log("\n(dry run — pass --commit to route these into paper incubation)"); return; }

  for (const c of chosen) {
    const cid = c.id as Id<"candidates">;
    await cx.mutation(api.paper.ensureAccount, { candidateId: cid, startEquity: 10_000 });
    // tag metrics so the dashboard knows it's a forward-paper seed
    const cand = await cx.query(api.candidates.get, { id: cid });
    const m = cand?.metrics ? JSON.parse(cand.metrics) : {};
    m.forwardPaper = 1; m.forwardPaperSeed = 1;
    await cx.mutation(api.candidates.updateStage, {
      id: cid, stage: "incubating",
      metrics: JSON.stringify(m),
      incubationStartedAt: Date.now(),
    });
    await cx.mutation(api.pipeline.addLesson, {
      source: c.src, candidateId: cid,
      text: `FORWARD-PAPER SEED: "${c.name}" (${c.family}, OOS ${c.oos.toFixed(2)}) passed the real significance battery (bootCI.lo ${c.res.bootLo.toFixed(2)}>0, deflated(p5) ${c.res.deflatedSharpe.toFixed(2)}) — honest, not overfit, just below the deflated-1.0 real-money bar. Routed to PAPER forward-testing to build a live track record. Real-money promotion stays strict.`,
    });
    console.log(`  → seeded ${c.name} into paper incubation`);
  }
  console.log(`\nSeeded ${chosen.length} sleeves. The paper-step cron (hourly) will now forward-test them.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
