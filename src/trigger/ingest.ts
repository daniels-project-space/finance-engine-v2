import { logger, schedules } from "@trigger.dev/sdk";
import { api, convex } from "../lib/convexClient";
import { mergeConfig } from "../lib/appConfig";
import { buildBtcBenchmark, fetchSpx } from "../lib/benchmark";
import { aggregateBars, ingestSymbol, loadBars } from "../lib/data";
import { candleKey, putJsonGz } from "../lib/storage";
import { ingestDvol, DVOL_CURRENCIES } from "../lib/deribit";
import { ingestOnchain, ONCHAIN_ASSETS } from "../lib/coinmetrics";
import { ingestStablecoins } from "../lib/defillama";

export const ingestCandles = schedules.task({
  id: "ingest-candles",
  cron: "2 * * * *", // hourly, just after bar close
  machine: "small-2x",
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
      // derive 4h + 1d for EVERY symbol (strategies choose their own timeframe)
      for (const symbol of cfg.universe) {
        const base = await loadBars(symbol, cfg.tf);
        if (!base) continue;
        for (const target of ["4h", "1d"] as const) {
          const agg = aggregateBars(base, target);
          await putJsonGz(candleKey(symbol, target), agg);
          await cx.mutation(api.pipeline.upsertDataset, {
            symbol, tf: target, firstTs: agg.t[0] ?? 0, lastTs: agg.t[agg.t.length - 1] ?? 0,
            bars: agg.t.length, gaps: 0, r2Key: candleKey(symbol, target),
          });
        }
      }
      // refresh benchmarks once a day (~midnight pass), or whenever missing.
      // SPX from FRED/Yahoo; BTC buy-and-hold from our own ingested 1d closes —
      // both rebased client-side onto each chart's window for "beats both".
      const refreshSpx = new Date().getUTCHours() === 0 || !(await cx.query(api.pipeline.getConfig, { key: "benchmark_spx" }));
      const refreshBtc = new Date().getUTCHours() === 0 || !(await cx.query(api.pipeline.getConfig, { key: "benchmark_btc" }));
      if (refreshSpx) {
        const spx = await fetchSpx((m) => logger.log(m));
        if (spx) await cx.mutation(api.pipeline.setConfig, { key: "benchmark_spx", json: JSON.stringify(spx) });
      }
      if (refreshBtc) {
        const btcBars = await loadBars("BTC/USDT", "1d");
        const btc = buildBtcBenchmark(btcBars);
        if (btc) {
          await cx.mutation(api.pipeline.setConfig, { key: "benchmark_btc", json: JSON.stringify(btc) });
          logger.log(`benchmark_btc: ${btc.t.length} pts`);
        }
      }
      // refresh Deribit DVOL (BTC/ETH implied-vol index) once a day — the
      // orthogonal options-IV series for the IV-timing sleeve. Free, incremental.
      if (new Date().getUTCHours() === 0) {
        const historyStart = Date.parse(cfg.historyStart);
        for (const cur of DVOL_CURRENCIES) {
          try { const s = await ingestDvol(cur, historyStart, (m) => logger.log(m)); logger.log(`dvol ${cur}: ${s.t.length} days`); }
          catch (e) { logger.log(`dvol ${cur} skipped: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
        }
        // refresh ON-CHAIN (Coin Metrics community + DefiLlama stablecoins), daily.
        for (const a of ONCHAIN_ASSETS) {
          try { const s = await ingestOnchain(a, historyStart, (m) => logger.log(m)); logger.log(`onchain ${a}: ${s.t.length} days`); }
          catch (e) { logger.log(`onchain ${a} skipped: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
        }
        try { const st = await ingestStablecoins((m) => logger.log(m)); logger.log(`stablesupply: ${st.t.length} days`); }
        catch (e) { logger.log(`stablesupply skipped: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
      }
      await cx.mutation(api.pipeline.finishRun, { id: runId, status: "ok", summary: JSON.stringify(results) });
      return results;
    } catch (err) {
      await cx.mutation(api.pipeline.finishRun, { id: runId, status: "error", summary: String(err).slice(0, 500) });
      throw err;
    }
  },
});
