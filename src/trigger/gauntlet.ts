import { logger, queue, task } from "@trigger.dev/sdk";
import { convex } from "../lib/convexClient";
import { processCandidate } from "../pipeline/process";

const gauntletQueue = queue({ name: "gauntlet", concurrencyLimit: 4 });

export const gauntletTask = task({
  id: "run-gauntlet",
  machine: "small-2x",
  maxDuration: 1700,
  queue: gauntletQueue,
  run: async (payload: { candidateId: string }) =>
    processCandidate(convex(), payload.candidateId, (m) => logger.log(m)),
});
