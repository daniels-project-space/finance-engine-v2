// Convex-native crons (no Trigger dependency): keep the materialized dashboard
// summaries fresh and enforce candidate-curve retention.

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// 2026-07-07 — widened 15 min → 60 min → 6h. rebuild does a FULL paginated scan of
// the candidates table (docs average ~33 KB — fat curves/metrics/dsl JSON), so each
// run reads tens–hundreds of MB just to produce cosmetic funnel/family/progression
// summaries + refresh the dashboard caches. That full-table fat scan is the single
// biggest DB-IO cost on the whole Convex team. The funnel is a slow-moving research
// view and the paper-book/gate caches tolerate ≤6h staleness, so 6h cadence cuts
// this ~4× again vs 60 min (~24× vs the original 15 min).
crons.interval("rebuild dashboard summaries", { hours: 6 }, internal.summaries.rebuild, {});
crons.daily("prune failed candidate curves", { hourUTC: 3, minuteUTC: 17 }, internal.summaries.prune, {});

export default crons;
