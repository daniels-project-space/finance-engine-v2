# /watch Upgrade Plan — Live Strategy Cockpit

**Project:** `/home/ubuntu/finance-engine-v2` (Next.js 15 App Router + Convex `glad-poodle-88` + Trigger.dev, Vercel `finance-engine-v2-cyan`).
**Target page:** `src/app/watch/page.tsx`.
**Date:** 2026-06-28.

## Goal (from Daniel)

The Watch tab runs the best/active strategy as live paper trading. It must:
1. Graph the **indicators** the strategy uses to decide, with the **threshold lines** where it would trigger.
2. Mark **the moment of each trade** clearly on the price chart with an **X (buy/sell)** + the **remark** (the signal reason).
3. Show + track **CAGR, win-rate, and other metrics** under the chart, updating **with every trade**, for **live trading only** (so everything starts at 0 at the beginning of live trading).
4. Show **return since beginning of trading** for **BTC HODL** and **S&P 500** alongside the strategy's return.
5. Easy, polished, visual.
6. **Generalize:** every strategy shows the same kind of view for *its own* indicators/logic (not just the 70/30 blend).

## Reconciled facts (verified in code)

- **"70/30 strat" = the `blend` sleeve**: target weight = `0.70*legA + 0.30*legB`. Leg A = on-chain valuation (NUPL = 1−1/MVRV, with on-chain confirm + 200d-MA), Leg B = BTC trend (`close > SMA(smaWin)`). Both long-flat, weight in [0,1]. (`src/trigger/paper.ts:104-151`, `src/engine/blendsleeve*.ts`.)
- **Live trader is real, not random**: `paperStep` Trigger cron `"12 * * * *"` computes signals on **daily** OKX closes + CoinMetrics on-chain, trades only when `|wTo − prevWeight| > 0.02`. Writes `paperTrades{candidateId,symbol,ts,weightFrom,weightTo,price,fillPrice,costUsd,note}` and hourly `equitySnapshots{candidateId,ts,equity,ret}`.
- **`note` already carries the remark**, e.g. `blend:A70/B30 legA0.62 legB0.30`.
- **Start timestamp exists**: `paperAccounts.startedAt` = true beginning of live paper trading. Live metrics rebase here → 0 at the start.
- **Benchmarks already in Convex**: `config.benchmark_spx` and `config.benchmark_btc` (`{t,c}` daily series), surfaced by `dashboard.benchmarks`. Used on backtest pages, **not yet on /watch**.
- **Metrics already computed** (CAGR/Sharpe/maxDD/Calmar/winRate) for backtests in `candidates.metrics`; forward Sharpe/maxDD in `dashboard.paperBook`. None of the live-forward set is rendered on /watch today.
- **Charts** are hand-rolled SVG (`src/app/components/ds.tsx` `Chart`/`ChartWithBenchmarks`; `LiveCandles` inline in the page). No chart library dependency.
- **Strategy families** (registry in `convex/dashboard.ts sleeveFamilies`): `blend`, `onchain` (MVRV/NVT z-score), `ivsleeve` (DVOL z-score), `trendbeta` (SMA), `xsection`, `DSL` (evolved). Each has retrievable indicators + thresholds + trade notes.

## Key design decisions

**D1 — Trade-mark canvas (timescale).** The blend decides on daily closes and trades rarely. Trade Xs + indicator trigger-lines render on the **decision-timeframe price chart over the full live period** (daily candles since `startedAt`), where Xs are actually visible. The existing **1m OKX candle feed stays as a secondary "live now" pane** (and shows an X if a trade fell inside its window). *Changing the strategy to trade intraday is out of scope.*

**D2 — Charting library.** RECOMMEND adding **`lightweight-charts`** (TradingView, free, ~45KB) for the price + indicator panes: it has first-class candlesticks, **series markers** (the buy/sell X with text), crosshair, tooltips, and time-synced multi-pane — exactly this feature, with far less custom SVG. Keep the existing zero-dep `ds.tsx` `Chart` for the 3-line comparison curve. *(Alternative: stay 100% hand-rolled SVG — more work, fully consistent with current code, no new dep. Decision needed at approval.)*

**D3 — Generic per-strategy view.** Build a normalized backend payload so any sleeve renders the same way. Wire the **blend fully first** as the reference, then add the other families' indicator descriptors. The page gets a **strategy picker** (the page is currently hardcoded to `source === "blend"`).

**D4 — Benchmarks.** Strategy return, BTC HODL, and S&P 500 all rebased to `startedAt` as **% return** (growth-of-$1). SPX trades market-hours only → step-hold across nights/weekends. BTC HODL from `config.benchmark_btc` (daily) extended with the live OKX last price for "today".

## Architecture

### Backend (Convex)
New file `convex/watch.ts`:
- `query strategyView({ candidateId })` → normalized payload:
  ```ts
  {
    meta: { key, label, family, symbol, startedAt, daysLive, currentWeight, position: "LONG"|"CASH"|"PARTIAL" },
    price: { tf: "1d", bars: [{t,o,h,l,c}] },              // decision-TF candles over live period
    trades: [{ ts, side: "BUY"|"SELL"|"REWEIGHT", from, to, price, note, reason }], // reason = humanized note
    indicators: [                                          // generic, family-specific
      { id, label, unit, series: [{t,v}], thresholds: [{label, value, kind: "buy"|"sell"}], current }
    ],
    metrics: { totalReturnPct, cagrPct, winRatePct, sharpe, maxDDPct, trades, daysLive, timeInMarketPct, avgWinPct, avgLossPct },
    benchmarks: { strat: [{t,v}], btcHodl: [{t,v}], spx: [{t,v}] } // rebased to startedAt, % return
  }
  ```
- Reuse engine fns (`blendsleeve.blendTargetNow`, onchain z-score, etc.) to reconstruct **indicator series + thresholds** over the live window from `datasets` daily bars + on-chain. Reuse `equitySnapshots` for the equity curve, `paperTrades` for marks/reasons, `paperAccounts.startedAt` for the rebase, `config.benchmark_*` for benchmarks.
- `query liveStrategies()` → list of watchable candidates (one per active sleeve family + champions) for the picker.

New `src/lib/livemetrics.ts`: pure fns computing CAGR (annualized from `startedAt`), win-rate (profitable weight-reductions / closed legs), forward Sharpe, maxDD, time-in-market, avg win/loss — from `equitySnapshots` + `paperTrades`. Returns 0/empty cleanly when no live history yet.

New `src/engine/indicators.ts`: `indicatorsFor(family, doc, bars)` → `[{id,label,unit,series,thresholds,current}]`. Implement `blend` first (legA on-chain value vs nuplBuy/nuplSell lines; legB price-vs-SMA; combined weight track), then `onchain`/`ivsleeve`/`trendbeta`.

### Frontend
Rewrite `src/app/watch/page.tsx` + new components under `src/app/components/`:
- `StrategyPicker` — dropdown over `liveStrategies()`; drives `candidateId`.
- `SignalPriceChart` — lightweight-charts: daily candles + buy/sell **X markers** (`note` as marker text/tooltip) + indicator sub-panes with **threshold lines**. Time-synced.
- `LiveTape` — keep the existing 1m OKX candle pane as "live now", marker if a trade is in-window.
- `MetricStrip` — tiles: Return, CAGR, Win-rate, Sharpe, MaxDD, Trades, Days live, Time-in-market. Reactive (updates on every new trade/snapshot). All 0 at start.
- `ComparisonChart` — `ds.tsx Chart` with 3 rebased % lines: Strategy / BTC HODL / S&P 500, legend + last-value labels.
- `TradeLog` — enhanced rows: time, BUY/SELL chip, weight from→to, price, and parsed **reason** + indicator values at trigger.

## Phases

- **Phase 0 — Verify live trader is actually running.** Confirm the **prod** Convex deployment used by the Vercel app (env on Vercel, not just `.env.local` `dev:glad-poodle-88`), confirm `paperStep` is deployed on Trigger.dev and `equitySnapshots`/`paperAccounts.lastStepTs` are fresh. If not running, the "updates with every trade" requirement can't hold — fix deploy first.
- **Phase 1 — Backend `convex/watch.strategyView` (blend)**: price bars, trades+reasons, blend indicators+thresholds, live metrics, rebased benchmarks. Unit-check against known values.
- **Phase 2 — Frontend price+signal chart** (lightweight-charts): candles, buy/sell Xs + remarks, indicator panes + threshold lines.
- **Phase 3 — Metric strip + comparison chart** (Strategy vs BTC HODL vs S&P 500, from `startedAt`, 0 at start).
- **Phase 4 — Generalize**: `indicatorsFor` for `onchain`/`ivsleeve`/`trendbeta` (+ graceful degrade for `xsection`/`DSL`), strategy picker.
- **Phase 5 — Polish + verify**: layout, tooltips, responsive, empty/zero states; Playwright screenshots on a Vercel preview; deploy.

## Risks / notes
- **Daily decision TF** ⇒ infrequent trades (see D1). Set expectations in the UI ("daily-rebalanced").
- **SPX market-hours gaps** ⇒ step-hold; label clearly.
- **1m candles not persisted** ⇒ signal Xs use trade `ts` mapped onto the daily/period chart, not 1m history.
- **Prod vs dev Convex** ⇒ Phase 0 must pin the deployment the live site reads, or changes won't show.
- **New dep** (`lightweight-charts`) if D2 approved; otherwise hand-rolled SVG.

## Out of scope
- Changing strategy logic or making it trade intraday.
- Real-money execution.
