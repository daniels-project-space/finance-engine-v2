// Manual evolution cycle: generate candidates and run their gauntlets inline,
// writing everything to Convex exactly like the cloud tasks do. Used for the
// kickoff and for ad-hoc cycles. Usage: npx tsx scripts/cycle-local.ts [scale]
//   scale multiplies the batch size (default 1).

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { generateBatch, getAppConfig, processCandidate, runRealityCheckBatch, runBookBatch, type ShadowOosCollector } from "../src/pipeline/process";

async function main() {
  const scale = Number(process.argv[2] ?? "1");
  const url = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL missing");
  const cx = new ConvexHttpClient(url);
  const runId = await cx.mutation(api.pipeline.startRun, { kind: "evolve" });
  const t0 = Date.now();
  try {
    const cfg = await getAppConfig(cx);
    console.log(`config: ${cfg.universe.join(" ")} ${cfg.tf}, seal=${cfg.sealDate}, scale=${scale}`);
    const summary = await generateBatch(cx, cfg, console.log, scale);
    console.log(`generated: gp=${summary.gp} fresh=${summary.fresh} llm=${summary.llm} dup=${summary.duplicates} -> ${summary.queued} queued ${summary.llmSkipped ? `(llm: ${summary.llmSkipped})` : ""}\n`);

    let passed = 0, failed = 0;
    // SHADOW: collect S4+ survivors' OOS streams for the batch Reality Check.
    const shadowCollector: ShadowOosCollector = [];
    for (const [i, id] of summary.ids.entries()) {
      const tC = Date.now();
      try {
        const res = await processCandidate(cx, id, console.log, { shadowCollector });
        const cand = await cx.query(api.candidates.get, { id: id as never });
        const secs = ((Date.now() - tC) / 1000).toFixed(1);
        if (res.passed) { passed++; console.log(`${i + 1}/${summary.ids.length} PASS  ${cand?.name} (${secs}s) composite=${res.composite?.toFixed(2)}`); }
        else { failed++; console.log(`${i + 1}/${summary.ids.length} kill  ${cand?.name} (${secs}s) at ${res.stage}: ${cand?.failedReason ?? ""}`); }
      } catch (err) {
        failed++;
        console.log(`${i + 1}/${summary.ids.length} err   ${err instanceof Error ? err.message.slice(0, 140) : err}`);
      }
    }
    // batch-level Reality Check over this cycle's S4+ survivors (shadow/log only)
    try { await runRealityCheckBatch(cx, shadowCollector, console.log); }
    catch (e) { console.log(`reality-check batch skipped: ${e instanceof Error ? e.message : e}`); }
    // WAVE-2: build the diversification book over the same survivors (shadow/log only)
    try { await runBookBatch(cx, shadowCollector, console.log); }
    catch (e) { console.log(`book batch skipped: ${e instanceof Error ? e.message : e}`); }
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    await cx.mutation(api.pipeline.finishRun, { id: runId, status: "ok", summary: JSON.stringify({ ...summary, ids: undefined, passed, failed, mins }) });
    console.log(`\ncycle done in ${mins}min: ${passed} into incubation, ${failed} killed`);
  } catch (err) {
    await cx.mutation(api.pipeline.finishRun, { id: runId, status: "error", summary: String(err).slice(0, 500) });
    throw err;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
