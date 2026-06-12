"use client";

import { useQuery } from "convex/react";
import { use } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Sparkline, StageBadge, Stat, fmtNum, fmtPct, timeAgo } from "../../components/ui";

export default function CandidateDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const candidateId = id as Id<"candidates">;
  const cand = useQuery(api.candidates.get, { id: candidateId });
  const reports = useQuery(api.pipeline.reportsFor, { candidateId });
  const acct = useQuery(api.paper.getAccount, { candidateId });
  const snaps = useQuery(api.paper.snapshots, { candidateId, limit: 720 });
  const trades = useQuery(api.paper.recentTrades, { candidateId, limit: 20 });

  if (!cand) return <div className="hud">loading…</div>;
  const metrics = cand.metrics ? (JSON.parse(cand.metrics) as Record<string, number>) : {};
  const equity = snaps ? [...snaps].reverse().map((s) => s.equity) : [];

  return (
    <div className="space-y-6">
      <section className="panel p-6">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold">{cand.name}</h1>
          <StageBadge stage={cand.stage} />
          <span className="num text-dim text-xs">{cand.source} · {timeAgo(cand.createdAt)} · {cand.hash.slice(0, 10)}</span>
        </div>
        <p className="text-dim mt-2 max-w-3xl">{cand.hypothesis}</p>
        {cand.failedReason && <p className="text-down mt-2 text-sm num">✗ {cand.failedStage}: {cand.failedReason}</p>}
        <div className="flex gap-8 mt-5 flex-wrap">
          <Stat label="Composite" value={fmtNum(cand.composite)} tone="gold" />
          <Stat label="Train Sharpe" value={fmtNum(metrics.trainSharpe)} />
          <Stat label="WF OOS Sharpe" value={fmtNum(metrics.wfPooledSharpe)} />
          <Stat label="WF positive months" value={fmtPct(metrics.wfPctPositive, 0)} />
          <Stat label="DSR" value={fmtNum(metrics.dsr, 3)} />
          <Stat label="Permutation p" value={fmtNum(metrics.permutationP, 3)} />
          <Stat label="Bootstrap p5" value={fmtNum(metrics.bootstrapP5)} />
          <Stat label="Sealed Sharpe" value={fmtNum(metrics.sealedSharpe)} tone={metrics.sealedSharpe > 0 ? "up" : undefined} />
        </div>
      </section>

      {acct && (
        <section className="panel p-5 flex gap-10 items-end flex-wrap">
          <Stat label="Paper equity" value={`$${acct.equity.toFixed(0)}`} tone={acct.equity >= 10000 ? "up" : "down"} />
          <Stat label="Peak" value={`$${acct.peakEquity.toFixed(0)}`} />
          <Stat label="Status" value={acct.halted ? `HALTED: ${acct.haltReason}` : "live"} tone={acct.halted ? "down" : "up"} />
          <div>
            <div className="hud mb-1">Equity curve</div>
            <Sparkline values={equity} width={420} height={64} />
          </div>
        </section>
      )}

      <section className="panel p-5">
        <div className="hud mb-3">Gauntlet report card</div>
        <div className="space-y-2">
          {reports?.map((r) => (
            <details key={r._id} className="border border-edge rounded p-2">
              <summary className="flex items-center gap-3 cursor-pointer text-sm">
                <span className={`num ${r.passed ? "text-up" : "text-down"}`}>{r.passed ? "✓" : "✗"}</span>
                <span className="num w-32">{r.stage}</span>
                <span className="text-dim text-xs">{r.reason ?? ""}</span>
                <span className="num text-dim text-xs ml-auto">{(r.durationMs / 1000).toFixed(1)}s</span>
              </summary>
              <pre className="num text-[11px] text-dim mt-2 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(JSON.parse(r.report || "{}"), null, 1)}</pre>
            </details>
          ))}
          {!reports?.length && <div className="text-dim text-sm">No gate reports yet.</div>}
        </div>
      </section>

      {!!trades?.length && (
        <section className="panel p-5">
          <div className="hud mb-3">Recent paper trades</div>
          <table className="w-full text-sm num">
            <thead><tr className="hud text-left"><th className="pb-1">time</th><th>symbol</th><th className="text-right">w from→to</th><th className="text-right">fill</th><th className="text-right">cost</th></tr></thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t._id} className="border-t border-edge/60">
                  <td className="py-1 text-dim text-xs">{new Date(t.ts).toISOString().slice(5, 16)}</td>
                  <td>{t.symbol}</td>
                  <td className={`text-right ${t.weightTo > t.weightFrom ? "text-up" : "text-down"}`}>{t.weightFrom.toFixed(2)}→{t.weightTo.toFixed(2)}</td>
                  <td className="text-right">{t.fillPrice.toFixed(2)}</td>
                  <td className="text-right text-dim">${t.costUsd.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="panel p-5">
        <div className="hud mb-3">Strategy DSL {cand.bestParams ? "· tuned params" : ""}</div>
        {cand.bestParams && <pre className="num text-xs text-gold mb-3">{cand.bestParams}</pre>}
        <pre className="num text-[11px] text-dim overflow-x-auto">{JSON.stringify(JSON.parse(cand.dsl), null, 1)}</pre>
      </section>
    </div>
  );
}
