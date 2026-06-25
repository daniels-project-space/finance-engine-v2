"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import { Chart, Panel, Stat, StageBadge, Pill, Spark, fmt, pct, type Curve } from "../components/ds";
import { srcColor, familyOf } from "../components/widgets2";

interface Row {
  id: string; name: string; stage: string; source: string; family: string;
  composite: number; oos: number; failedStage?: string; tf: string;
  m: Record<string, number>; curve?: Curve; alive: boolean;
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
  };
}

function safeParse<T>(s: string | undefined | null): T | null { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } }

// rebase a {t,c} benchmark to growth-of-1 over [t0,t1]; skip non-finite/<=0 closes
// so one bad row can't NaN-poison the chart.
function rebase(raw: string | null | undefined, t0: number, t1: number): Curve | undefined {
  const b = safeParse<{ t: number[]; c: number[] }>(raw ?? null);
  if (!b || !t0 || !t1) return undefined;
  const t: number[] = [], eq: number[] = [];
  let base = 0;
  for (let i = 0; i < Math.min(b.t.length, b.c.length); i++) {
    const ts = b.t[i], close = b.c[i];
    if (ts < t0 || ts > t1) continue;
    if (!Number.isFinite(close) || close <= 0) continue;
    if (!base) base = close;
    t.push(ts); eq.push(close / base);
  }
  return t.length > 2 ? { t, eq } : undefined;
}

export default function TournamentPage() {
  const rowsRaw = useQuery(api.candidates.tournament, { limit: 60 });
  const spxRaw = useQuery(api.pipeline.getConfig, { key: "benchmark_spx" });
  const btcRaw = useQuery(api.pipeline.getConfig, { key: "benchmark_btc" });
  const [selected, setSelected] = useState<string | null>(null);

  const rows = (rowsRaw ?? []).map(parseRow);
  // RANK by OOS Sharpe (the most meaningful metric), composite as tiebreak.
  rows.sort((a, b) => (b.oos - a.oos) || (b.composite - a.composite));

  const sel = rows.find((r) => r.id === selected) ?? rows[0];
  const headline = sel?.curve;
  const t0 = headline?.t?.[0] ?? 0, t1 = headline?.t?.[headline.t.length - 1] ?? 0;
  const spx = rebase(spxRaw, t0, t1);
  const btc = rebase(btcRaw, t0, t1);
  const stratMult = headline?.eq?.length ? headline.eq[headline.eq.length - 1] : undefined;
  const spxMult = spx?.eq?.length ? spx.eq[spx.eq.length - 1] : undefined;
  const btcMult = btc?.eq?.length ? btc.eq[btc.eq.length - 1] : undefined;

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
              {sel.failedStage && <span className="num text-[11px] text-down">died at {sel.failedStage}</span>}
            </div>
            <Chart height={300} yLabel="growth of $10k" series={[
              { name: sel.alive ? "strategy (live)" : "strategy (backtest)", color: "#3ddb9e", curve: headline },
              ...(spx ? [{ name: "S&P 500", color: "#8b9aab", curve: spx, dash: true }] : []),
              ...(btc ? [{ name: "BTC HODL", color: "#f5b932", curve: btc, dash: true }] : []),
            ]} />
            {stratMult !== undefined && (
              <div className="flex items-center gap-3 mt-3 flex-wrap">
                <span className="num text-[12px] text-dim">$10k →
                  <span className="text-up"> ${(stratMult * 10000).toFixed(0)}</span> strategy
                  {spxMult !== undefined && <span className="text-mid"> · ${(spxMult * 10000).toFixed(0)} S&P 500</span>}
                  {btcMult !== undefined && <span className="text-accent"> · ${(btcMult * 10000).toFixed(0)} BTC HODL</span>}
                </span>
                {spxMult !== undefined && <Pill tone={stratMult > spxMult ? "up" : "down"}>{stratMult > spxMult ? "beats" : "trails"} S&P</Pill>}
                {btcMult !== undefined && <Pill tone={stratMult > btcMult ? "up" : "down"}>{stratMult > btcMult ? "beats" : "trails"} BTC</Pill>}
              </div>
            )}
            <p className="num text-[10px] text-dim mt-2">
              Out-of-sample equity over the validated window, rebased to $10k alongside both benchmarks on the same window.{sel.failedStage ? ` This candidate died at ${sel.failedStage} — a strong backtest that did not clear the full gauntlet, shown honestly.` : ""}
            </p>
          </>
        ) : <div className="well flex items-center justify-center" style={{ height: 300 }}><span className="hud">no scored candidates yet</span></div>}
      </Panel>

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
                    className={isSel ? "bg-[#f5b9320e]" : ""}>
                    <td style={{ textAlign: "left" }} className={`dt-num ${i === 0 ? "text-accent" : "text-dim"}`}>{i === 0 ? "★ 1" : i + 1}</td>
                    <td style={{ textAlign: "left" }}>
                      <Link href={`/candidates/${r.id}`} onClick={(e) => e.stopPropagation()} className="text-mid hover:text-up">{r.name}</Link>
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
