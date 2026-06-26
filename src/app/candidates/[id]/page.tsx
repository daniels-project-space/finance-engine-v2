"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { use } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import {
  Chart, Drawdown, Panel, Stat, StageBadge, Pill, MetricGrid, Spark, KV,
  fmt, pct, ago, type Curve, type MetricDef, type Tone,
} from "../../components/ds";
import { GauntletTrail, srcColor, familyOf } from "../../components/widgets2";

// every metric we might have — MetricGrid renders only the ones that exist, so an
// early-death candidate shows its real numbers instead of a wall of dashes.
const METRICS: MetricDef[] = [
  { label: "Train Sharpe", key: "trainSharpe", tone: (v) => (v > 0 ? "fg" : "down") },
  { label: "WF OOS Sharpe", key: "wfPooledSharpe", tone: (v) => (v > 0 ? "up" : "down") },
  { label: "Port OOS Sharpe", key: "portOosSharpe", tone: (v) => (v > 0 ? "up" : "down") },
  { label: "Sealed Sharpe", key: "sealedSharpe", tone: (v) => (v > 0 ? "up" : "down") },
  { label: "WF % positive", key: "wfPctPositive", kind: "pct", tone: "fg" },
  { label: "Port % positive", key: "portPctPositive", kind: "pct", tone: "fg" },
  { label: "Cross-symbol +", key: "crossSymbolPositive", tone: (v) => (v > 0 ? "up" : "down") },
  { label: "WF worst month", key: "wfWorstMonth", kind: "pct", tone: (v) => (v < -0.2 ? "down" : "dim") },
  { label: "WF max DD", key: "wfMaxDD", kind: "pct", tone: (v) => (v < -0.25 ? "down" : "dim") },
  { label: "Port max DD", key: "portMaxDD", kind: "pct", tone: (v) => (v < -0.25 ? "down" : "dim") },
  { label: "Full max DD", key: "fullMaxDD", kind: "pct", tone: (v) => (v < -0.25 ? "down" : "dim") },
  { label: "Yearly return", key: "fullCagr", kind: "pct", tone: (v) => (v > 0 ? "up" : "down") },
  { label: "Win rate", key: "winRate", kind: "pct", tone: "fg" },
  { label: "Trades", key: "fullTrades", digits: 0, tone: "dim" },
  { label: "DSR", key: "dsr", digits: 3, tone: (v) => (v >= 0.95 ? "up" : "accent") },
  { label: "Permutation p", key: "permutationP", digits: 3, tone: (v) => (v < 0.05 ? "up" : "down") },
  { label: "Bootstrap p5", key: "bootstrapP5", tone: (v) => (v > 0 ? "up" : "down") },
  { label: "PBO", key: "pbo", digits: 2, tone: (v) => (v < 0.5 ? "up" : "down") },
  { label: "Book deflated", key: "bookDeflated", tone: (v) => (v >= 1 ? "up" : "accent") },
  { label: "Book div ratio", key: "bookDivRatio", tone: "info" },
];

export default function CandidateDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const candidateId = id as Id<"candidates">;
  const cand = useQuery(api.candidates.get, { id: candidateId });
  const reports = useQuery(api.pipeline.reportsFor, { candidateId });
  const acct = useQuery(api.paper.getAccount, { candidateId });
  const snaps = useQuery(api.paper.snapshots, { candidateId, limit: 720 });
  const trades = useQuery(api.paper.recentTrades, { candidateId, limit: 16 });

  if (cand === undefined) return <div className="hud py-10 text-center">loading…</div>;
  if (cand === null) return <div className="hud py-10 text-center">candidate not found</div>;

  const m: Record<string, number> = safeParse(cand.metrics) ?? {};
  const cv: { full?: Curve; wf?: Curve; sealed?: Curve; port?: Curve } = safeParse(cand.curves) ?? {};
  const headline = cv.port ?? cv.wf ?? cv.full;
  const headlineLabel = cv.port ? "Portfolio OOS" : cv.wf ? "Walk-forward OOS" : "Full backtest";
  const mult = headline?.eq?.length ? headline.eq[headline.eq.length - 1] : undefined;
  const fam = familyOf(cand.source);
  const equity = snaps ? [...snaps].reverse().map((s) => s.equity) : [];

  const score = cand.composite;
  const oos = m.portOosSharpe ?? m.wfPooledSharpe;

  return (
    <div className="space-y-4 stagger">
      {/* back */}
      <Link href="/strategies" className="num text-[11px] text-dim hover:text-fg inline-flex items-center gap-1">← strategies</Link>

      {/* ===================== HEADER ===================== */}
      <Panel pad="p-6">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2 mb-4">
          <h1 className="text-[22px] font-semibold tracking-tight text-fg">{cand.name}</h1>
          <div className="flex items-center gap-2 pt-1">
            <StageBadge stage={cand.stage} />
            <Pill tone="info">{fam}</Pill>
            <span className="num text-[10px]" style={{ color: srcColor(cand.source) }}>{cand.source}</span>
          </div>
          <div className="ml-auto num text-[10px] text-dim pt-1.5">{ago(cand.createdAt)} ago · {cand.hash.slice(0, 10)}</div>
        </div>

        <p className="text-mid text-sm max-w-3xl leading-relaxed mb-5">{cand.hypothesis}</p>

        {/* headline stats — always-present ones */}
        <div className="flex flex-wrap gap-x-10 gap-y-4 mb-5">
          <Stat label="Composite" value={fmt(score)} tone="accent" size="lg" />
          <Stat label="OOS Sharpe" value={fmt(oos)} tone={(oos ?? 0) > 0 ? "up" : "down"} size="lg" />
          <div className="min-w-0">
            <div className="hud mb-2">Gauntlet trail</div>
            <GauntletTrail failedStage={cand.failedStage} stage={cand.stage} />
            {cand.failedReason && <div className="num text-[10px] text-down mt-2">✗ {cand.failedStage}: {cand.failedReason}</div>}
            {!cand.failedStage && <div className="num text-[10px] text-up mt-2">✓ survived the gauntlet</div>}
          </div>
        </div>

        <div className="hr my-4" />
        <div className="hud mb-3">All validation metrics — this candidate</div>
        <MetricGrid metrics={m} defs={METRICS} />
      </Panel>

      {/* ===================== EQUITY ===================== */}
      {headline && (
        <Panel title={`Equity — ${headlineLabel}`} right={mult !== undefined ? (
          <span className="num text-[11px] text-dim">$10k → <span className={mult >= 1 ? "text-up" : "text-down"}>${(mult * 10000).toFixed(0)}</span></span>
        ) : undefined}>
          <Chart series={[{ name: headlineLabel, color: "#3ddb9e", curve: headline }]} height={230} />
          {cv.full && <div className="mt-2"><Drawdown curve={cv.full} /></div>}
          {(cv.full || cv.sealed || (cv.wf && cv.port)) && (
            <div className="mt-4">
              <div className="hud mb-2">Other windows</div>
              <Chart height={170} series={[
                ...(cv.full ? [{ name: "full backtest", color: "#5cc8ff", curve: cv.full }] : []),
                ...(cv.sealed ? [{ name: "sealed holdout", color: "#f5b932", curve: cv.sealed }] : []),
                ...(cv.wf && cv.port ? [{ name: "BTC-only WF", color: "#c191fb", curve: cv.wf, dash: true }] : []),
              ]} />
            </div>
          )}
        </Panel>
      )}

      {/* ===================== PAPER (if incubating) ===================== */}
      {acct && (() => {
        const rets = snaps ? [...snaps].reverse().map((s) => s.ret) : [];
        const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
        const sd = rets.length ? Math.sqrt(Math.max(0, rets.reduce((a, b) => a + b * b, 0) / rets.length - mean * mean)) : 0;
        const liveSharpe = sd > 1e-12 ? (mean / sd) * Math.sqrt(8760) : 0;
        let peak = -Infinity, liveDD = 0;
        for (const e of equity) { peak = Math.max(peak, e); liveDD = Math.min(liveDD, peak > 0 ? e / peak - 1 : 0); }
        return (
          <Panel title="Live paper incubation">
            <div className="flex flex-wrap gap-x-10 gap-y-4 items-end">
              <Stat label="Paper equity" value={`$${acct.equity.toFixed(0)}`} tone={acct.equity >= 10000 ? "up" : "down"} />
              <Stat label="Live Sharpe" value={rets.length > 48 ? fmt(liveSharpe) : "warming"} tone={liveSharpe > 0 ? "up" : "dim"} size="sm" />
              <Stat label="Live max DD" value={pct(liveDD, 1)} tone={liveDD < -0.05 ? "down" : "dim"} size="sm" />
              <Stat label="Peak" value={`$${acct.peakEquity.toFixed(0)}`} size="sm" />
              <Stat label="Status" value={acct.halted ? "HALTED" : "live"} tone={acct.halted ? "down" : "up"} size="sm" sub={acct.halted ? acct.haltReason : undefined} />
              <div className="ml-auto min-w-0"><Spark values={equity} width={300} height={48} fill tone="up" /></div>
            </div>
          </Panel>
        );
      })()}

      {/* ===================== GATE REPORTS + DSL ===================== */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Panel title="Gauntlet report card">
          <div className="space-y-1.5">
            {(reports ?? []).map((r) => (
              <details key={r._id} className="group">
                <summary className="flex items-center gap-3 cursor-pointer text-xs py-1.5 list-none">
                  <span className={`num ${r.passed ? "text-up" : "text-down"}`}>{r.passed ? "✓" : "✗"}</span>
                  <span className="num w-32 text-mid">{r.stage}</span>
                  <span className="text-dim truncate flex-1">{r.reason ?? ""}</span>
                  <span className="num text-dim">{(r.durationMs / 1000).toFixed(1)}s</span>
                </summary>
                <pre className="num text-[10px] text-dim mt-1 mb-2 ml-6 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">{prettyJson(r.report)}</pre>
              </details>
            ))}
            {!reports?.length && <div className="hud py-2">no gate reports</div>}
          </div>
        </Panel>

        <Panel title={`Strategy DSL${cand.bestParams ? " · tuned params" : ""}`}>
          {cand.bestParams && <pre className="num text-[10px] text-accent mb-3 overflow-x-auto">{prettyJson(cand.bestParams)}</pre>}
          <pre className="num text-[10px] text-dim overflow-x-auto max-h-72 overflow-y-auto">{prettyJson(cand.dsl)}</pre>
        </Panel>
      </div>

      {/* ===================== TRADES ===================== */}
      {!!trades?.length && (
        <Panel title="Recent paper trades">
          <div className="tablewrap">
            <table className="dt">
              <thead><tr><th>time</th><th>symbol</th><th>weight</th><th>fill</th><th>cost</th></tr></thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t._id}>
                    <td style={{ textAlign: "left" }} className="dt-num text-dim text-xs">{new Date(t.ts).toISOString().slice(5, 16)}</td>
                    <td style={{ textAlign: "left" }} className="text-mid">{t.symbol}</td>
                    <td className={`dt-num ${t.weightTo > t.weightFrom ? "text-up" : "text-down"}`}>{t.weightFrom.toFixed(2)}→{t.weightTo.toFixed(2)}</td>
                    <td className="dt-num text-fg">{t.fillPrice.toFixed(2)}</td>
                    <td className="dt-num text-dim">${t.costUsd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

function safeParse<T>(s: string | undefined | null): T | null { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } }
function prettyJson(s: string | undefined | null): string { const o = safeParse(s); return o ? JSON.stringify(o, null, 1) : (s ?? "—"); }
