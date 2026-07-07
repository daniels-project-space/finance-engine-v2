// Convex-native crons (no Trigger dependency): keep the materialized dashboard
// summaries fresh and enforce candidate-curve retention.

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// 2026-07-07 — widened 15 min → 60 min. rebuild does a FULL paginated scan of the
// (unbounded, fat curves/metrics docs) candidates table every run to produce three
// cosmetic dashboard summaries (stageFlow funnel / sleeveFamilies / progression).
// At 15 min that was 96 full-table scans/day — the dominant DB-IO cost after the
// live candidates.funnel/analytics queries were removed (2026-07-04). The funnel is
// a slow-moving research view, so hourly staleness is invisible. ~75% fewer scans.
crons.interval("rebuild dashboard summaries", { minutes: 60 }, internal.summaries.rebuild, {});
crons.daily("prune failed candidate curves", { hourUTC: 3, minuteUTC: 17 }, internal.summaries.prune, {});

export default crons;
