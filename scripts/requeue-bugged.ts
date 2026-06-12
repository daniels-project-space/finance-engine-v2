// Resurrect candidates killed by the NaN-composition engine bug (their
// signals never fired, so "train sharpe 0.00" deaths were not real
// evaluations). Re-runs the unchanged gauntlet on the fixed engine.
// Usage: npx tsx scripts/requeue-bugged.ts

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { processCandidate } from "../src/pipeline/process";

async function main() {
  const url = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL missing");
  const cx = new ConvexHttpClient(url);
  const failed = await cx.query(api.candidates.listByStage, { stage: "failed", limit: 400 });
  const bugged = failed.filter((c) =>
    c.failedStage === "S2-train" && /sharpe -?0\.00 </.test(c.failedReason ?? ""),
  );
  console.log(`${bugged.length} bug-killed candidates to resurrect (of ${failed.length} failed)`);
  let passed = 0;
  for (const [i, cand] of bugged.entries()) {
    await cx.mutation(api.candidates.updateStage, { id: cand._id, stage: "queued" });
    const t0 = Date.now();
    try {
      const res = await processCandidate(cx, cand._id as unknown as string, () => {});
      const after = await cx.query(api.candidates.get, { id: cand._id });
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      if (res.passed) { passed++; console.log(`${i + 1}/${bugged.length} PASS  ${cand.name} (${secs}s) composite=${res.composite?.toFixed(2)}`); }
      else console.log(`${i + 1}/${bugged.length} kill  ${cand.name} (${secs}s) at ${res.stage}: ${after?.failedReason ?? ""}`);
    } catch (err) {
      console.log(`${i + 1}/${bugged.length} err   ${cand.name}: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    }
  }
  console.log(`resurrection done: ${passed} into incubation`);
}

main().catch((e) => { console.error(e); process.exit(1); });
