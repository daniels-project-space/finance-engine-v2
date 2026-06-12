import { logger, schedules } from "@trigger.dev/sdk";
import { api, convex } from "../lib/convexClient";
import { generateBatch, getAppConfig } from "../pipeline/process";
import { gauntletTask } from "./gauntlet";

export const evolveCycle = schedules.task({
  id: "evolve-cycle",
  cron: "20 */3 * * *",
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
