// Indicators step — precompute the Watch tab's chart data for every paper-traded
// strategy. SEPARATE from paper-step (the live trader is never touched): this task
// loads the daily bars (+ on-chain for the blend) from R2, maps each strategy into
// the normalized indicator payload (candles + the indicators it trades on + the
// exact trigger lines + the exposure track), and persists it to Convex so the
// reactive /watch query can read the full chart with zero heavy compute.
//
// Daily decision data changes once a day, so a 30-minute cadence is plenty fresh.

import { logger, schedules } from "@trigger.dev/sdk";
import { api, convex } from "../lib/convexClient";
import { loadBars, attachOnchain } from "../lib/data";
import { buildStrategyIndicators } from "../engine/indicators";
import { isBlendSleeve } from "../engine/blendsleeve";
import type { Bars } from "../engine/types";
import type { Id } from "../../convex/_generated/dataModel";

function symbolOf(rawDoc: unknown): string {
  const d = (rawDoc ?? {}) as { symbol?: string; coins?: { symbol: string }[] };
  return d.symbol ?? d.coins?.[0]?.symbol ?? "BTC/USDT";
}

export const indicatorsStep = schedules.task({
  id: "indicators-step",
  cron: "23,53 * * * *", // every 30 min, off the paper-step (:12) mark
  machine: "small-2x",
  maxDuration: 600,
  run: async () => {
    const cx = convex();
    const incubating = await cx.query(api.candidates.listByStage, { stage: "incubating" });
    const eligible = await cx.query(api.candidates.listByStage, { stage: "eligible" });
    const champion = await cx.query(api.candidates.champion, {});
    const actives = [...incubating, ...eligible, ...(champion ? [champion] : [])];
    if (!actives.length) { logger.log("indicators: no active strategies"); return { built: 0 }; }

    const barsCache = new Map<string, Bars | null>();
    const getBars = async (sym: string): Promise<Bars | null> => {
      if (!barsCache.has(sym)) barsCache.set(sym, await loadBars(sym, "1d"));
      return barsCache.get(sym) ?? null;
    };

    let built = 0;
    for (const cand of actives) {
      try {
        const candidateId = cand._id as Id<"candidates">;
        // only build for strategies that are actually being paper-traded (shown on /watch)
        const acct = await cx.query(api.paper.getAccount, { candidateId });
        if (!acct) continue;

        const rawDoc = JSON.parse(cand.dsl) as unknown;
        const sym = symbolOf(rawDoc);
        const bars0 = await getBars(sym);
        if (!bars0) { logger.log(`indicators: bars unavailable for ${cand.name} (${sym})`); continue; }
        // the blend's NUPL needs MVRV attached; others use raw price bars
        const bars = isBlendSleeve(rawDoc) ? await attachOnchain(bars0, sym) : bars0;

        const payload = buildStrategyIndicators(rawDoc, bars);
        if (!payload.candles.length) { logger.log(`indicators: no candles for ${cand.name}`); continue; }
        await cx.mutation(api.watch.saveIndicators, { candidateId, json: JSON.stringify(payload) });
        built++;
      } catch (err) {
        logger.error(`indicators failed for ${cand.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
    logger.log(`indicators: ${built}/${actives.length} strategies refreshed`);
    return { built };
  },
});
