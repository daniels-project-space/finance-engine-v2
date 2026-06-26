"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import { ChartWithBenchmarks, Panel, StageBadge, Pill, Spark, fmt, pct, type Curve } from "../components/ds";
import { srcColor, familyOf } from "../components/widgets2";

interface Row {
  id: string; name: string; stage: string; source: string; family: string;
  composite: number; oos: number; failedStage?: string; tf: string;
  m: Record<string, number>; curve?: Curve; alive: boolean; regime: boolean;
}

const ALIVE = new Set(["champion", "eligible", "incubating", "sealed_passed"]);

function parseRow(c: { _id: string; name: string; stage: string; source: string; composite?: number; failedStage?: string; metrics?: string; curves?: string; dsl?: string }): Row {
  let m: Record<string, number> = {}, curve: Curve | undefined, tf = "";
  try { m = c.metrics ? JSON.parse(c.metrics) : {}; } catch { /* */ }
  try { const cv = c.curves ? JSON.parse(c.curves) as { wf?: Curve; port?: Curve } : {}; curve = cv.port ?? cv.wf; } catch { /* */ }
  try { tf = c.dsl ? (JSON.parse(c.dsl).tf ?? "") : ""; } catch { /* */ }
  return {
    id: c._id, name: c.name, stage: c.stage, source: c.source, family: familyOf(c.source),
    composite: c.composite ?? 0, oos: m.portOosSharpe ?? m.wfPooledSharpe ?? 0,
    failedStage: c.failedStage, tf, m, curve, alive: ALIVE.has(c.stage),
    regime: c.source === "regime" || m.userStrategy === 1,
  };
}

export default function TournamentPage() {
  const rowsRaw = useQuery(api.candidates.tournament, { limit: 60 });
  const bench = useQuery(api.dashboard.benchmarks, {});
  const [selected, setSelected] = useState<string | null>(null);

  const rows = (rowsRaw ?? []).map(parseRow);
  // RANK by OOS Sharpe (the most meaningful metric), composite as tiebreak.
  rows.sort((a, b) => (b.oos - a.oos) || (b.composite - a.composite));

  const sel = rows.find((r) => r.id === selected) ?? rows[0];
  const headline = sel?.curve;
  const t0 = headline?.t?.[0] ?? 0, t1 = headline?.t?.[headline.t.length - 1] ?? 0;
  const fmtD = (ts: number) => ts ? new Date(ts).toISOString().slice(0, 7) : "?";
  const windowYrs = t0 && t1 ? ((t1 - t0) / (365 * 86400_000)).toFixed(1) : "?";
  const windowLabel = t0 && t1 ? `${fmtD(t0)} - ${fmtD(t1)} (${windowYrs}y)` : "";

  return (
    <div className="space-y-5 stagger pb-10">
      {/* ============ honest framing ============ */}
      <div className="flex items-center gap-2.5 flex-wrap pt-2">
        <Pill tone="info">backtest leaderboard</Pill>
        <span className="num text-[11px] text-dim">ranked by out-of-sample Sharpe — these are the best <span className="text-fg">backtested</span> candidates, not live/promoted. The honest forward bets are on the <Link href="/" className="text-up hover:underline">paper book</Link>.</span>
      </div>

      {/* ============ #1 (or selected) chart — ALWAYS with SPX + BTC overlaid ============ */}
      <Panel pad="p-6"
        title={sel ? <>Best strategy — equity vs S&amp;P 500 &amp; BTC buy-hold</> : "Best strategy"}
        right={sel ? (
          <Link href={`/candidates/${sel.id}`} className="num text-[10px] text-dim hover:text-fg flex items-center gap-2">
            {sel.name} <StageBadge stage={sel.stage} />
          </Link>
        ) : undefined}>
        {sel && headline ? (
          <>
            <div className="flex items-baseline gap-3 mb-3 flex-wrap">
              <span className="num text-[11px]" style={{ color: srcColor(sel.source) }}>{sel.source}</span>
              <span className="num text-[11px] text-mid">{sel.family}</span>
              {sel.tf && <span className="num text-[11px] text-dim">{sel.tf}</span>}
              <span className="num text-[11px] text-dim">OOS Sharpe <span className="text-up">{fmt(sel.oos)}</span></span>
              {windowLabel && <span className="num text-[11px] text-accent">window {windowLabel}</span>}
              {sel.failedStage && <span className="num text-[11px] text-down">died at {sel.failedStage}</span>}
            </div>
            <ChartWithBenchmarks
              height={300} yLabel="growth of $1" showMetrics
              storeKey="tournament" benchmarks={bench}
              stratLabel={sel.alive ? "strategy (live)" : "strategy (backtest)"}
              series={[{ name: sel.alive ? "strategy (live)" : "strategy (backtest)", color: "#3ddb9e", curve: headline }]}
            />
            <p className="num text-[10px] text-dim mt-3">
              Strategy vs S&amp;P 500 &amp; BTC buy-and-hold, all rebased over the SAME window ({windowLabel}). Toggle the benchmarks above each chart. A high BTC multiple can just reflect a window starting near a bottom — read beats/trails relative to THIS period.{sel.failedStage ? ` Died at ${sel.failedStage} — strong backtest, did not clear the full gauntlet, shown honestly.` : ""}
            </p>
          </>
        ) : <div className="well flex items-center justify-center" style={{ height: 300 }}><span className="hud">no scored candidates yet</span></div>}
      </Panel>

      {/* ============ regime-aware / Daniel's strategies (blue-glow, pinned) ============ */}
      {rows.some((r) => r.regime) && (
        <Panel pad="p-5" className="blue-glow-pulse" title={<span className="blue-glow-text">★ Regime-aware strategies (Daniel&apos;s chop-gated trend)</span>} right={<span className="num text-[10px] text-dim">backtest — live forward test on the Overview</span>}>
          <div className="tablewrap">
            <table className="dt">
              <thead><tr><th>strategy</th><th>family</th><th>OOS Sharpe</th><th>composite</th><th>max DD</th><th>stage</th><th>chart</th></tr></thead>
              <tbody>
                {rows.filter((r) => r.regime).map((r) => {
                  const dd = r.m.fullMaxDD ?? r.m.portMaxDD ?? r.m.wfMaxDD;
                  return (
                    <tr key={r.id} onClick={() => setSelected(r.id)} style={{ cursor: "pointer" }} className="blue-glow">
                      <td style={{ textAlign: "left" }}><Link href={`/candidates/${r.id}`} onClick={(e) => e.stopPropagation()} className="blue-glow-text hover:underline">{r.name}</Link></td>
                      <td style={{ textAlign: "left" }} className="num text-[10px] blue-glow-text">{r.family}</td>
                      <td className="dt-num text-up">{fmt(r.oos)}</td>
                      <td className="dt-num text-accent">{fmt(r.composite)}</td>
                      <td className={`dt-num ${(dd ?? 0) < -0.25 ? "text-down" : "text-dim"}`}>{dd !== undefined ? pct(dd, 0) : "—"}</td>
                      <td><StageBadge stage={r.stage} /></td>
                      <td><div className="flex justify-end">{r.curve ? <Spark values={r.curve.eq} width={70} height={20} tone="info" /> : <span className="hud">—</span>}</div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="num text-[10px] text-dim mt-3">SMA120 + choppiness&lt;50 chop-gate — the regime-aware trend that beat buy-and-hold in backtest. Now forward-testing live on paper (currently in cash — BTC is below its SMA). Click to chart it vs S&amp;P/BTC.</p>
        </Panel>
      )}

      {/* ============ the ranked leaderboard ============ */}
      <Panel pad="p-5" title="Leaderboard — best backtested candidates" right={<span className="num text-[10px] text-dim">click a row to chart it · ranked by OOS Sharpe</span>}>
        <div className="tablewrap">
          <table className="dt">
            <thead><tr>
              <th>#</th><th>strategy</th><th>family</th><th>OOS Sharpe</th><th>composite</th>
              <th>max DD</th><th>win%</th><th>trades</th><th>stage</th><th>equity</th>
            </tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const isSel = r.id === sel?.id;
                const dd = r.m.portMaxDD ?? r.m.wfMaxDD ?? r.m.fullMaxDD;
                return (
                  <tr key={r.id} onClick={() => setSelected(r.id)} style={{ cursor: "pointer" }}
                    className={`${r.regime ? "blue-glow" : ""} ${isSel ? "bg-[#f5b9320e]" : ""}`}>
                    <td style={{ textAlign: "left" }} className={`dt-num ${i === 0 ? "text-accent" : "text-dim"}`}>{i === 0 ? "★ 1" : i + 1}</td>
                    <td style={{ textAlign: "left" }}>
                      <Link href={`/candidates/${r.id}`} onClick={(e) => e.stopPropagation()} className={r.regime ? "blue-glow-text hover:underline" : "text-mid hover:text-up"}>{r.name}</Link>
                      {r.regime && <span className="num text-[8px] ml-2 px-1.5 py-0.5 rounded blue-glow-text" style={{ background: "#5cc8ff18" }}>★ regime-aware</span>}
                      <span className="num text-[9px] ml-2" style={{ color: srcColor(r.source) }}>{r.source}</span>
                    </td>
                    <td style={{ textAlign: "left" }} className="num text-[10px] text-dim">{r.family}</td>
                    <td className="dt-num text-up">{fmt(r.oos)}</td>
                    <td className="dt-num text-accent">{fmt(r.composite)}</td>
                    <td className={`dt-num ${(dd ?? 0) < -0.25 ? "text-down" : "text-dim"}`}>{dd !== undefined ? pct(dd, 0) : "—"}</td>
                    <td className="dt-num text-dim">{r.m.winRate !== undefined ? pct(r.m.winRate, 0) : "—"}</td>
                    <td className="dt-num text-dim">{r.m.fullTrades !== undefined ? r.m.fullTrades : "—"}</td>
                    <td>{r.failedStage ? <span className="num text-[9px] text-down">✗ {r.failedStage}</span> : <StageBadge stage={r.stage} />}</td>
                    <td><div className="flex justify-end">{r.curve ? <Spark values={r.curve.eq} width={70} height={20} /> : <span className="hud">—</span>}</div></td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={10} className="hud py-6" style={{ textAlign: "center" }}>no scored candidates yet</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
