// CALIBRATED-UNLOCK TEST: re-run the strongest existing gauntlet candidates
// through the UNCHANGED gauntlet under the NEW live floors (read via
// getAppConfig inside processCandidate). Mirrors scripts/requeue-bugged.ts.
// Reads candidate ids from /tmp/rerun_ids.json (top-N by composite).
// Usage: npx tsx scripts/rerun-floors-test.ts
import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "fs";
import { api } from "../convex/_generated/api";
import { processCandidate } from "../src/pipeline/process";

async function main() {
  const url = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL missing");
  const cx = new ConvexHttpClient(url);
  const targets = JSON.parse(readFileSync("/tmp/rerun_ids.json", "utf8")) as { id: string; name: string; comp: number }[];
  console.log(`re-running ${targets.length} top candidates under live floors`);
  let passed = 0;
  const results: Record<string, number> = {};
  for (const [i, t] of targets.entries()) {
    await cx.mutation(api.candidates.updateStage, { id: t.id as never, stage: "queued" });
    const t0 = Date.now();
    try {
      const res = await processCandidate(cx, t.id, () => {});
      const after = await cx.query(api.candidates.get, { id: t.id as never });
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      results[res.stage ?? "?"] = (results[res.stage ?? "?"] ?? 0) + 1;
      if (res.passed) { passed++; console.log(`${i + 1}/${targets.length} PASS  ${t.name} (${secs}s) -> ${after?.stage} composite=${res.composite?.toFixed(2)}`); }
      else console.log(`${i + 1}/${targets.length} kill  ${t.name} (${secs}s) at ${res.stage}: ${after?.failedReason ?? ""}`);
    } catch (err) {
      console.log(`${i + 1}/${targets.length} err   ${t.name}: ${err instanceof Error ? err.message.slice(0, 140) : err}`);
    }
  }
  console.log(`\nDONE: ${passed}/${targets.length} into incubation`);
  console.log("stage distribution:", JSON.stringify(results));
}
main().catch((e) => { console.error(e); process.exit(1); });
