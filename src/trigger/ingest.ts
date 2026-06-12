import { logger, schedules } from "@trigger.dev/sdk/v3";
import { api, convex } from "../lib/convexClient";
import { mergeConfig } from "../lib/appConfig";
import { aggregateBars, ingestSymbol, loadBars } from "../lib/data";
import { candleKey, putJsonGz } from "../lib/storage";

export const ingestCandles = schedules.task({
  id: "ingest-candles",
  cron: "2 * * * *", // hourly, just after bar close
  machine: { preset: "small-2x" },
  maxDuration: 1500,
  run: async () => {
    const cx = convex();
    const runId = await cx.mutation(api.pipeline.startRun, { kind: "ingest" });
    try {
      const cfg = mergeConfig(await cx.query(api.pipeline.getConfig, { key: "app" }));
      const historyStartTs = Date.parse(cfg.historyStart);
      const results = [];
      for (const symbol of cfg.universe) {
        const res = await ingestSymbol(symbol, cfg.tf, historyStartTs, (m) => logger.log(m));
        results.push(res);
        await cx.mutation(api.pipeline.upsertDataset, {
          symbol, tf: cfg.tf, firstTs: res.firstTs, lastTs: res.lastTs,
          bars: res.bars, gaps: res.gaps, fundingLastTs: res.fundingLastTs, r2Key: candleKey(symbol, cfg.tf),
        });
        logger.log(`${symbol}: ${res.bars} bars (+${res.appended}), ${res.gaps} gaps, src=${res.source}`);
      }
      // derive 4h for the primary (cross-timeframe validation)
      const primary = await loadBars(cfg.primarySymbol, cfg.tf);
      if (primary) {
        const agg = aggregateBars(primary, "4h");
        await putJsonGz(candleKey(cfg.primarySymbol, "4h"), agg);
        await cx.mutation(api.pipeline.upsertDataset, {
          symbol: cfg.primarySymbol, tf: "4h", firstTs: agg.t[0] ?? 0, lastTs: agg.t[agg.t.length - 1] ?? 0,
          bars: agg.t.length, gaps: 0, r2Key: candleKey(cfg.primarySymbol, "4h"),
        });
      }
      await cx.mutation(api.pipeline.finishRun, { id: runId, status: "ok", summary: JSON.stringify(results) });
      return results;
    } catch (err) {
      await cx.mutation(api.pipeline.finishRun, { id: runId, status: "error", summary: String(err).slice(0, 500) });
      throw err;
    }
  },
});
