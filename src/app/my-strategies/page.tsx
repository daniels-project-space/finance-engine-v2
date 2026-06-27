"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "../../../convex/_generated/api";
import { ChartWithBenchmarks, Lead, Info, fmt, pct, type Curve } from "../components/ds";

// ================================================================ MY STRATEGIES
// Daniel's validated strategies as first-class cards: plain-English description,
// since-2020 (or since-inception) metrics, and an equity chart with BTC HODL + S&P
// overlays. Read-only — backed by the persisted "my_strategies" spike-backtest
// config. HONEST: these are backtests; the live forward-test is on the Live tab.

interface Strat {
  key: string; name: string; tag: string; desc: string; start: string; leverage: number; hodlLabel?: string;
  total: number; cagr: number; maxDD: number; sharpe: number; calmar: number; winRate: number; timeInMkt: number;
  curve: { t: number[]; eq: number[] }; btcHodl: { t: number[]; c: number[] };
}

const TAG_TONE: Record<string, string> = {
  "your strategy": "blue-glow-text", flagship: "blue-glow-text", "best risk-adjusted": "text-up", "beats BTC at lower risk": "text-accent", aggressive: "text-down",
};

export default function MyStrategiesPage() {
  const data = useQuery(api.dashboard.myStrategies, {});
  const bench = useQuery(api.dashboard.benchmarks, {});

  if (data === undefined) return <div className="hud py-20 text-center">loading…</div>;
  if (data === null || !data.strategies?.length) {
    return <div className="py-20 text-center"><div className="text-[18px] text-mid">No strategies recorded yet.</div></div>;
  }
  const strategies = data.strategies as unknown as Strat[];

  return (
    <div className="space-y-7 stagger pb-14">
      <Lead dot="ok">
        These are <span className="text-fg">Daniel&apos;s validated strategies</span> — each shown vs just holding Bitcoin and the S&amp;P 500 since 2020.{" "}
        <span className="text-dim text-[15px]">All numbers are historical backtests (the live forward-test is on the Live tab). Forward drawdown runs deeper than backtest.</span>
      </Lead>

      {strategies.map((s, i) => {
        const curve: Curve = { t: s.curve.t, eq: s.curve.eq };
        const tagCls = TAG_TONE[s.tag] ?? "text-mid";
        const ddTone = Math.abs(s.maxDD) < 0.3 ? "text-up" : Math.abs(s.maxDD) < 0.5 ? "text-accent" : "text-down";
        return (
          <section key={s.key} className={`panel p-7 ${i === 0 ? "blue-glow-pulse" : ""}`}>
            {/* header: name + tag + leverage */}
            <div className="flex items-start justify-between gap-4 flex-wrap mb-3">
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="text-[20px] text-fg font-medium">{s.name}</span>
                  <span className={`num text-[9px] px-2 py-0.5 rounded ${tagCls}`} style={{ background: "#ffffff0a" }}>{s.tag}</span>
                  {s.leverage > 1 && <span className="num text-[9px] px-2 py-0.5 rounded blue-glow-text" style={{ background: "#5cc8ff14" }}>{s.leverage}× leverage</span>}
                </div>
                <div className="num text-[10px] text-dim mt-1">tracked since {s.start}</div>
              </div>
              {/* the one big number */}
              <div className="text-right">
                <div className="hud mb-0.5">total return</div>
                <div className={`num text-[34px] leading-none ${s.total >= 0 ? "text-up" : "text-down"}`}>{s.total >= 0 ? "+" : ""}{(s.total * 100).toFixed(0)}%</div>
              </div>
            </div>

            {/* plain-English description */}
            <p className="text-[13px] text-mid leading-relaxed max-w-3xl mb-5">{s.desc}</p>

            {/* metrics strip */}
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-x-5 gap-y-3 mb-5 rounded-lg border border-edge/50 p-4">
              <Metric label="CAGR" value={pct(s.cagr, 0)} />
              <Metric label={<span className="flex items-center">worst dip<Info>Max drawdown — biggest drop from a peak. Smaller is safer.</Info></span>} value={pct(s.maxDD, 0)} tone={ddTone} />
              <Metric label={<span className="flex items-center">Sharpe<Info>Return per unit of risk. Above ~1 is good.</Info></span>} value={fmt(s.sharpe)} />
              <Metric label={<span className="flex items-center">Calmar<Info>Return per unit of drawdown. Higher = better risk-adjusted.</Info></span>} value={fmt(s.calmar)} />
              <Metric label="win rate" value={pct(s.winRate, 0)} />
              <Metric label={<span className="flex items-center">in market<Info>Share of days holding a position (vs sitting in cash).</Info></span>} value={pct(s.timeInMkt, 0)} />
            </div>

            {/* chart: strategy + BTC HODL + S&P 500, rebased over the strategy window */}
            <ChartWithBenchmarks
              height={300} yLabel="growth of $1" showMetrics
              storeKey={`mystrat-${s.key}`}
              benchmarks={{ spx: bench?.spx ?? null, btc: null }}
              extra={s.btcHodl?.t?.length ? [{ label: s.hodlLabel ?? "BTC HODL", color: "#f5b932", raw: s.btcHodl, primary: true }] : []}
              stratLabel={s.name}
              series={[{ name: s.name, color: i === 0 ? "#5cc8ff" : "#3ddb9e", curve }]}
            />
          </section>
        );
      })}

      <div className="flex justify-center pt-2">
        <Link href="/" className="num text-[12px] text-dim hover:text-fg">see them live →</Link>
      </div>
    </div>
  );
}

function Metric({ label, value, tone = "text-fg" }: { label: React.ReactNode; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="hud mb-1">{label}</div>
      <div className={`num text-[18px] leading-none ${tone}`}>{value}</div>
    </div>
  );
}
