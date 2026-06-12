# Alpha Forge — Specification

Self-improving crypto strategy lab. Successor to the VPS `finance-engine` (clean rebuild, not a port).
Stack: Next.js (Vercel) + Convex (system of record) + Trigger.dev (compute/schedules) + R2 (candles/artifacts).

## Why the old engine failed (audit 2026-06-12)

The VPS finance-engine had a complete anti-overfit toolkit (DSR, permutation tests, CPCV/PBO,
sealed holdout, bootstrap CI, black-swan replay, MC shuffle) — **and its promotion gate used none
of it**. Promotion was "beats current champion 2-of-3 on equity/Sharpe/maxDD", champion-relative
with no absolute floor. Result: 106 auto-promotions of negative-Sharpe strategies. Other defects:
same-bar-close fills (look-ahead), no funding/borrow costs, single-symbol (BTC 1h) evolution,
walk-forward that never re-tuned, paper layer never executed, LLM transport via `claude -p` CLI
with no fallback (its failure killed the loop).

## Design principles

1. **Strategies are data, not code.** A strategy is a typed JSON expression graph (DSL), compiled
   to vectorized TypeScript. No sandbox needed — safe by construction. Novelty = canonical graph
   hash. Mutation = graph surgery. Indicator *invention* = genetic programming over expression
   trees. The LLM proposes hypotheses and reads lessons; it does not write code.
2. **One mandatory gauntlet with absolute floors.** Nothing reaches paper without passing every
   stage. Nothing reaches champion without ≥30 days of live paper validation inside its own
   backtest-derived confidence bands.
3. **Causal everywhere.** Indicators are rolling windows ending at bar i. Decisions at close of
   bar i fill at open of bar i+1 with slippage. Stops evaluated on close, exit next open.
4. **Costs are real.** Taker fees, spread-based slippage, slippage stress ramp, and perp funding
   payments (8h) are in every backtest. We model USDT-M perpetuals (shorts legal, funding paid).
5. **The seal is a date, not a window.** Data after `sealDate` is untouched by generation, tuning,
   and stages S1–S5. Used exactly once per candidate at S6 (enforced by a unique Convex record).
6. **Dev lane never touches the live lane.** Evolution runs forever in dev; the champion only
   changes through the promotion protocol, with archive + one-click rollback.

## The DSL

```ts
Expr =
  | { op: "price", field: "open"|"high"|"low"|"close"|"volume" }
  | { op: "const", value: number }
  | { op: "param", name: string }                       // tunable, bounds in strategy.params
  | { op: ind, src: Expr, period: Expr }                // ema sma wma rsi atr stdev highest lowest
                                                        // lag zscore slope pctrank median roc
  | { op: "add"|"sub"|"mul"|"div"|"min2"|"max2", a, b }
  | { op: "abs"|"neg"|"log"|"sign"|"sqrt", a }
  | { op: "gt"|"lt"|"crossover"|"crossunder"|"and"|"or", a, b }
  | { op: "not", a }
```

Strategy document:
```ts
{
  name, hypothesis,                 // hypothesis: WHY this should work (LLM/GP must state it)
  longEntry, longExit, shortEntry?, shortExit?,   // boolean Exprs
  params: { [name]: { min, max, default, int? } } // ≤6 params
  risk: { stopAtrMult?, trailAtrMult?, volTargetAnnual, maxLeverage }
}
```
Complexity caps: ≤48 nodes/expression, ≤6 params, depth ≤10.

## Backtester

Weight-based vectorized simulation. Signal → target weight in [-maxLev, +maxLev], vol-targeted:
`w = dir * clamp(volTarget / realizedVol(EWMA), 0, maxLev)`. PnL = w·barReturn − turnover·(fee+slip)
− funding·w at funding stamps. ATR stop/trailing evaluated on close, applied next open. Metrics:
Sharpe/Sortino (per-TF annualization), CAGR, maxDD, Calmar, trade stats, monthly returns.

## Gauntlet (all floors absolute; any fail → candidate dies with a lesson)

| Stage | What | Floors |
|---|---|---|
| S0 static | schema, complexity, param count | structural |
| S1 novelty | canonical hash + family hash vs fingerprints + penalty box | unseen |
| S2 train fit | random-search tune on train slice only (≤ sealDate, first 70%) | Sharpe>0.8, ≥30 trades/yr, maxDD>-35% |
| S3 walk-forward | **re-tune per window**: tune 12mo → trade 1mo, step 1mo, ≥18 windows | mean OOS Sharpe>0.5, ≥55% positive months, worst month>-15%, OOS maxDD>-30% |
| S4 cross-symbol | best params per symbol re-fit quickly across universe | WF-positive on ≥3/5 symbols |
| S5 statistics | DSR (N = all trials ever, from DB), log-return permutation (200), bootstrap CI | DSR>0.95, p<0.05, CI lower>0 |
| S5b stress | slippage ramp ×3, param ±15% (8 samples), crisis replay windows, MC shuffle | Sharpe@3×slip > 50% base; perturbed mean > 60% base; crisis DD > -40% |
| S6 sealed | one-shot run on data ≥ sealDate (never seen) | Sharpe>0.5, return>0, DD>-30%, ≥10 trades |
| S7 paper | ≥30 days live paper, hourly steps, graduated sizing | live Sharpe within bootstrap 90% band, no kill-switch breach, realized slip < 2× model |

Composite score = 0.5·WF_OOS_Sharpe + 0.3·sealed_Sharpe + 0.2·full_Sharpe (ranking only — floors gate).

**Promotion**: eligible (S7 done) ∧ composite ≥ 1.1× champion composite ∧ approval (autoPromote=false
by default → approval queue in dashboard). Old champion → archived, instantly rollback-able.
**Demotion**: champion live Sharpe below its own bootstrap 5th percentile over 30d, or kill-switch
(daily -5% / weekly -10% / monthly -20%) → halt + alert + revert to previous champion.

## Evolution loop (Trigger.dev, every 6h)

Population = champions + top candidates by composite. Batch = 60% GP (mutate/crossover winners),
20% fresh grammar-sampled, 20% LLM-proposed (OpenRouter DeepSeek, JSON-only, schema-validated,
lessons + per-symbol market stats in prompt, provider pinned `only: ["deepseek","alibaba"]`).
Cheap stages S0–S2 inline; survivors spawn parallel gauntlet task runs. Every failure writes a
lesson `{stage, reason, family}`; lessons feed the next LLM prompt and bias GP operator weights.
Budgets: candidates/day and LLM calls/day caps in config.

## Data

Binance USDT-M perp klines (fapi) + funding history, spot fallback if geo-blocked. Universe v1:
BTC, ETH, SOL, BNB, XRP /USDT, 1h (4h derived). Columnar JSON.gz per symbol/tf in R2. Ingest task
hourly: append, validate gaps/outliers (gap > 2×tf or |return| > 30% flagged to `datasets.gaps`).

## Infra

- Convex deployment (own), Vercel project `alpha-forge`, Trigger `alpha-forge-jobs`
  (`proj_bnrpptsrzevrjmvixanl`), R2 bucket `alpha-forge`.
- Secrets in project-hub vault, service scopes `["alpha-forge"]`. Trigger env vars pushed via API.
- Dashboard: overview (champion, paper vs expected bands), funnel, candidate report cards,
  promotions/approvals, lessons, config (kill switch, floors, seal date).
