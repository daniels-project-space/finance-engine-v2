import { logger, schedules } from "@trigger.dev/sdk";
import { api, convex } from "../lib/convexClient";
import { generateBatch, getAppConfig } from "../pipeline/process";
import { gauntletTask } from "./gauntlet";

// The cloud worker now runs the subscription Claude Code CLI directly: the
// `claude` binary is baked into the Trigger image via additionalPackages
// (trigger.config.ts) and authenticated from the injected CLAUDE_CODE_OAUTH_TOKEN
// (a Trigger env var Claude Code reads automatically). runClaudeCli resolves the
// bin by absolute path and strips ANTHROPIC_API_KEY, so ideation runs on the
// flat-rate subscription and never bills the API. No EVOLUTION_DISABLE_CLI here.

export const evolveCycle = schedules.task({
  id: "evolve-cycle",
  // PARKED (Jan 1 only) — deploy-proof paused so the loop does NOT start firing.
  // Real cadence is "20 */3 * * *" (every 3h at :20). The orchestrator restores
  // that cron at go-live, after the CLAUDE_CODE_OAUTH_TOKEN is set and a
  // verification run passes.
  cron: "20 */3 * * *", // every 3h (00:20,03:20,...21:20 UTC)
  machine: "small-2x",
  maxDuration: 1500,
  run: async () => {
    const cx = convex();
    const runId = await cx.mutation(api.pipeline.startRun, { kind: "evolve" });
    try {
      const cfg = await getAppConfig(cx);
      const summary = await generateBatch(cx, cfg, (m) => logger.log(m));
      if (summary.ids.length) {
        await gauntletTask.batchTrigger(summary.ids.map((id) => ({ payload: { candidateId: id } })));
      }
      await cx.mutation(api.pipeline.finishRun, { id: runId, status: "ok", summary: JSON.stringify({ ...summary, ids: undefined }) });
      logger.log(`evolve cycle: queued ${summary.queued} (gp=${summary.gp} fresh=${summary.fresh} llm=${summary.llm} dup=${summary.duplicates})`);
      return summary;
    } catch (err) {
      await cx.mutation(api.pipeline.finishRun, { id: runId, status: "error", summary: String(err).slice(0, 500) });
      throw err;
    }
  },
});
