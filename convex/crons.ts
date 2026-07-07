// Convex-native crons (no Trigger dependency): keep the materialized dashboard
// summaries fresh and enforce candidate-curve retention.

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// 2026-07-07 — widened 15 min → 60 min → 6h → DAILY. rebuild does a FULL paginated
// scan of the candidates table (docs average ~33 KB — fat curves/metrics/dsl), the
// single biggest DB-IO cost on the whole Convex team. It only produces the cosmetic
// funnel/family/progression summaries + the slow-moving book-gate snapshot, so a
// daily scan is plenty (~24× fewer full scans than the original 15 min). The LIVE
// paper-book equity is refreshed every 6h by refreshPaperBook below — that scans
// only the active-stage candidates (small), so it stays fresh without the full scan.
crons.daily("rebuild dashboard summaries", { hourUTC: 2, minuteUTC: 40 }, internal.summaries.rebuild, {});
crons.interval("refresh paper book", { hours: 6 }, internal.summaries.refreshPaperBook, {});
crons.daily("prune failed candidate curves", { hourUTC: 3, minuteUTC: 17 }, internal.summaries.prune, {});

export default crons;
