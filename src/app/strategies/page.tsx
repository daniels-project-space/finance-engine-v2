"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import { ChartWithBenchmarks, Lead, Info, StageBadge, Spark, fmt, pct, type Curve } from "../components/ds";

// ================================================================ STRATEGIES
// "What are the best strategies, and do they beat just holding?" Plain-English
// answer up top, the best strategy charted vs S&P 500 + BTC (toggleable) with the
// 3-way numbers, then a simple ranked list. Folds the old Tournament/leaderboard.

interface Row {
  id: string; name: string; stage: string; source: string;
  composite: number; oos: number; failedStage?: string;
  m: Record<string, number>; curve?: Curve; alive: boolean; regime: boolean;
}
const ALIVE = new Set(["champion", "eligible", "incubating", "sealed_passed"]);

function parseRow(c: { _id: string; name: string; stage: string; source: string; composite?: number; failedStage?: string; metrics?: string; curves?: string }): Row {
  let m: Record<string, number> = {}, curve: Curve | undefined;
  try { m = c.metrics ? JSON.parse(c.metrics) : {}; } catch { /* */ }
  try { const cv = c.curves ? JSON.parse(c.curves) as { wf?: Curve; port?: Curve } : {}; curve = cv.port ?? cv.wf; } catch { /* */ }
  return {
    id: c._id, name: c.name, stage: c.stage, source: c.source,
    composite: c.composite ?? 0, oos: m.portOosSharpe ?? m.wfPooledSharpe ?? 0,
    failedStage: c.failedStage, m, curve, alive: ALIVE.has(c.stage),
    regime: c.source === "regime" || m.userStrategy === 1,
  };
}

export default function StrategiesPage() {
  const rowsRaw = useQuery(api.candidates.tournament, { limit: 40 });
  const bench = useQuery(api.dashboard.benchmarks, {});
  const trendHodl = useQuery(api.dashboard.trendVsHodl, {});
  const [selected, setSelected] = useState<string | null>(null);

  const rows = (rowsRaw ?? []).map(parseRow);
  rows.sort((a, b) => (b.oos - a.oos) || (b.composite - a.composite));

  const sel = rows.find((r) => r.id === selected) ?? rows[0];
  const headline = sel?.curve;
  const t0 = headline?.t?.[0] ?? 0, t1 = headline?.t?.[headline.t.length - 1] ?? 0;
  const fmtD = (ts: number) => ts ? new Date(ts).toISOString().slice(0, 7) : "?";
  const windowYrs = t0 && t1 ? ((t1 - t0) / (365 * 86400_000)).toFixed(1) : "?";
  const windowLabel = t0 && t1 ? `${fmtD(t0)} to ${fmtD(t1)} (${windowYrs}y)` : "";

  // plain-English headline: does the best risk-managed strategy beat holding BTC?
  const ts = trendHodl?.stats;
  const beatsRet = ts?.trendTotal != null && ts?.hodlTotal != null && ts.trendTotal > ts.hodlTotal;
  const ddImprove = ts?.trendMaxDD != null && ts?.hodlMaxDD != null && ts.hodlMaxDD !== 0 ? (1 - Math.abs(ts.trendMaxDD) / Math.abs(ts.hodlMaxDD)) : null;

  return (
    <div className="space-y-7 stagger pb-12">
      {/* ============ the plain-English answer ============ */}
      <Lead dot={beatsRet ? "ok" : undefined}>
        {trendHodl && ts
          ? <>The best risk-managed strategy {beatsRet ? <span className="text-up">beat holding Bitcoin</span> : "performed close to holding Bitcoin"}
              {ddImprove != null && ddImprove > 0.1 ? <> with about <span className="text-fg">{(ddImprove * 100).toFixed(0)}% less risk</span> (a much smaller worst dip)</> : ""} — shown below.{" "}
              <span className="text-dim text-[15px]">This is a historical test, not live trading.</span></>
          : <>These are the best strategies the engine has found, charted against just holding Bitcoin or the S&amp;P 500.</>}
      </Lead>

      {/* ============ best strategy chart vs S&P/BTC + the 3-way numbers ============ */}
      <section className="panel p-6">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <span className="hud flex items-center">Best strategy vs just holding<Info>Ranked by out-of-sample Sharpe — risk-adjusted return on data the strategy was not fitted to.</Info></span>
          {sel && <Link href={`/candidates/${sel.id}`} className="num text-[10px] text-dim hover:text-fg flex items-center gap-2">{sel.name} <StageBadge stage={sel.stage} /></Link>}
        </div>
        {sel && headline ? (
          <>
            <ChartWithBenchmarks
              height={320} yLabel="growth of $1" showMetrics
              storeKey="strategies" benchmarks={bench}
              stratLabel={sel.alive ? "this strategy (live)" : "this strategy"}
              series={[{ name: sel.alive ? "this strategy (live)" : "this strategy", color: "#3ddb9e", curve: headline }]}
            />
            <p className="num text-[10px] text-dim mt-3 max-w-3xl">
              All lines start at the same point over {windowLabel || "the same window"}, so you can compare directly. Use the toggle above the chart to show or hide the S&amp;P 500 and Bitcoin lines. A big Bitcoin number can just mean the window started near a price bottom — read it for this period, not as &ldquo;Bitcoin always wins.&rdquo;{sel.failedStage ? " This one looked strong but didn't pass every test — shown honestly." : ""}
            </p>
          </>
        ) : <div className="well flex items-center justify-center" style={{ height: 320 }}><span className="hud">no strategies scored yet</span></div>}
      </section>

      {/* ============ simple ranked list — fewer columns, plain headers ============ */}
      <div>
        <div className="hud mb-3">Top strategies <span className="text-dim normal-case">— click one to chart it</span></div>
        <div className="tablewrap">
          <table className="dt">
            <thead><tr>
              <th>#</th><th>strategy</th>
              <th>return<Info>Total backtest return over the test window.</Info></th>
              <th>worst dip<Info>Biggest drop from a peak (max drawdown). Smaller is safer.</Info></th>
              <th>quality<Info>Out-of-sample Sharpe — risk-adjusted return on unseen data. Higher is better.</Info></th>
              <th>proven?<Info>Did it pass the full testing battery (walk-forward, stats, sealed holdout)?</Info></th>
              <th>shape</th>
            </tr></thead>
            <tbody>
              {rows.slice(0, 20).map((r, i) => {
                // total return: from metrics if present, else derive from the curve
                const curveTotal = r.curve?.eq?.length ? r.curve.eq[r.curve.eq.length - 1] / r.curve.eq[0] - 1 : undefined;
                const ret = r.m.fullTotal ?? r.m.portTotal ?? curveTotal;
                const dd = r.m.fullMaxDD ?? r.m.portMaxDD ?? r.m.wfMaxDD;
                const isSel = r.id === sel?.id;
                return (
                  <tr key={r.id} onClick={() => setSelected(r.id)} style={{ cursor: "pointer" }}
                    className={`${r.regime ? "blue-glow" : ""} ${isSel ? "bg-[#f5b9320e]" : ""}`}>
                    <td style={{ textAlign: "left" }} className={`dt-num ${i === 0 ? "text-accent" : "text-dim"}`}>{i === 0 ? "★1" : i + 1}</td>
                    <td style={{ textAlign: "left" }}>
                      <Link href={`/candidates/${r.id}`} onClick={(e) => e.stopPropagation()} className={r.regime ? "blue-glow-text hover:underline" : "text-mid hover:text-up"}>{r.name}</Link>
                      {r.regime && <span className="num text-[8px] ml-2 px-1.5 py-0.5 rounded blue-glow-text" style={{ background: "#5cc8ff18" }}>★ yours</span>}
                    </td>
                    <td className={`dt-num ${(ret ?? 0) >= 0 ? "text-up" : "text-down"}`}>{ret !== undefined ? `${ret >= 0 ? "+" : ""}${(ret * 100).toFixed(0)}%` : "—"}</td>
                    <td className={`dt-num ${(dd ?? 0) < -0.25 ? "text-down" : "text-dim"}`}>{dd !== undefined ? pct(dd, 0) : "—"}</td>
                    <td className="dt-num text-up">{fmt(r.oos)}</td>
                    <td>{r.alive ? <span className="num text-[10px] text-up">✓ passed</span> : r.failedStage ? <span className="num text-[10px] text-dim">tested</span> : <StageBadge stage={r.stage} />}</td>
                    <td><div className="flex justify-end">{r.curve ? <Spark values={r.curve.eq} width={64} height={18} /> : <span className="hud">—</span>}</div></td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={7} className="hud py-6" style={{ textAlign: "center" }}>no strategies scored yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
