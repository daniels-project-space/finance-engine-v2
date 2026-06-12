// One-shot historical backfill (manual trigger from the Trigger dashboard or CLI).
import { logger, task } from "@trigger.dev/sdk";
import { api, convex } from "../lib/convexClient";
import { mergeConfig } from "../lib/appConfig";
import { aggregateBars, ingestSymbol, loadBars } from "../lib/data";
import { candleKey, putJsonGz } from "../lib/storage";

export const backfillHistory = task({
  id: "backfill-history",
  machine: "small-2x",
  maxDuration: 3000,
  run: async (payload: { symbols?: string[] } = {}) => {
    const cx = convex();
    const cfg = mergeConfig(await cx.query(api.pipeline.getConfig, { key: "app" }));
    const historyStartTs = Date.parse(cfg.historyStart);
    const symbols = payload.symbols ?? cfg.universe;
    const results = [];
    for (const symbol of symbols) {
      logger.log(`backfilling ${symbol} from ${cfg.historyStart}...`);
      const res = await ingestSymbol(symbol, cfg.tf, historyStartTs, (m) => logger.log(m));
      results.push(res);
      await cx.mutation(api.pipeline.upsertDataset, {
        symbol, tf: cfg.tf, firstTs: res.firstTs, lastTs: res.lastTs,
        bars: res.bars, gaps: res.gaps, fundingLastTs: res.fundingLastTs, r2Key: candleKey(symbol, cfg.tf),
      });
      logger.log(`${symbol}: ${res.bars} bars, ${res.gaps} gaps, source=${res.source}`);
    }
    const primary = await loadBars(cfg.primarySymbol, cfg.tf);
    if (primary) {
      const agg = aggregateBars(primary, "4h");
      await putJsonGz(candleKey(cfg.primarySymbol, "4h"), agg);
      logger.log(`derived ${agg.t.length} 4h bars for ${cfg.primarySymbol}`);
    }
    return results;
  },
});
