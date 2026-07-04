// Convex-native crons (no Trigger dependency): keep the materialized dashboard
// summaries fresh and enforce candidate-curve retention.

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("rebuild dashboard summaries", { minutes: 15 }, internal.summaries.rebuild, {});
crons.daily("prune failed candidate curves", { hourUTC: 3, minuteUTC: 17 }, internal.summaries.prune, {});

export default crons;
