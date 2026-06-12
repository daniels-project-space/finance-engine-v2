"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "../../convex/_generated/api";
import { Sparkline, StageBadge, Stat, fmtNum, fmtPct, timeAgo } from "./components/ui";

const FUNNEL_ORDER = ["queued", "gauntlet", "failed", "incubating", "eligible", "champion"];

export default function Overview() {
  const champion = useQuery(api.candidates.champion, {});
  const funnel = useQuery(api.candidates.funnel, {});
  const promotions = useQuery(api.promotions.history, { limit: 8 });
  const runs = useQuery(api.pipeline.recentRuns, { limit: 10 });
  const champSnaps = useQuery(
    api.paper.snapshots,
    champion ? { candidateId: champion._id, limit: 720 } : "skip",
  );
  const champAcct = useQuery(api.paper.getAccount, champion ? { candidateId: champion._id } : "skip");

  const metrics = champion?.metrics ? (JSON.parse(champion.metrics) as Record<string, number>) : undefined;
  const equitySeries = champSnaps ? [...champSnaps].reverse().map((s) => s.equity) : [];

  return (
    <div className="space-y-6">
      {/* champion card */}
      <section className="panel p-6">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <div className="hud mb-2">Live champion</div>
            {champion ? (
              <>
                <div className="flex items-center gap-3">
                  <Link href={`/candidates/${champion._id}`} className="text-2xl font-semibold text-gold hover:underline">
                    {champion.name}
                  </Link>
                  <StageBadge stage={champion.stage} />
                </div>
                <p className="text-dim text-sm mt-2 max-w-xl">{champion.hypothesis}</p>
              </>
            ) : (
              <div className="text-dim text-lg">
                No champion yet — the gauntlet has not been beaten.
                <p className="text-sm mt-1">That is by design. Nothing trades until it earns it.</p>
              </div>
            )}
          </div>
          {champion && (
            <div className="flex gap-8 items-end">
              <Stat label="Paper equity" value={champAcct ? `$${champAcct.equity.toFixed(0)}` : "—"} tone={champAcct && champAcct.equity >= 10000 ? "up" : "down"} />
              <Stat label="Composite" value={fmtNum(champion.composite)} tone="gold" />
              <Stat label="WF OOS Sharpe" value={fmtNum(metrics?.wfPooledSharpe)} />
              <Stat label="Sealed Sharpe" value={fmtNum(metrics?.sealedSharpe)} />
              <div>
                <div className="hud mb-1">Paper equity (30d)</div>
                <Sparkline values={equitySeries} />
              </div>
            </div>
          )}
        </div>
      </section>

      {/* funnel */}
      <section className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {FUNNEL_ORDER.map((stage) => (
          <Link key={stage} href={`/candidates?stage=${stage}`} className="panel p-4 hover:border-dim transition-colors">
            <div className="hud mb-1">{stage.replace("_", " ")}</div>
            <div className="num text-2xl">{funnel ? funnel[stage] ?? 0 : "·"}</div>
          </Link>
        ))}
      </section>

      <div className="grid md:grid-cols-2 gap-6">
        {/* promotions */}
        <section className="panel p-5">
          <div className="hud mb-3">Promotion log</div>
          <div className="space-y-2">
            {promotions?.length ? promotions.map((p) => (
              <div key={p._id} className="flex items-center gap-3 text-sm">
                <span className={`num text-[10px] uppercase px-1.5 py-0.5 rounded border ${p.action === "promote" ? "text-up border-emerald-900" : p.action === "demote" ? "text-down border-red-900" : "text-amber-300 border-amber-900"}`}>{p.action}</span>
                <span className="text-dim num text-xs">{timeAgo(p.createdAt)}</span>
                <span className="truncate text-dim">{p.note}</span>
              </div>
            )) : <div className="text-dim text-sm">No promotions yet.</div>}
          </div>
        </section>

        {/* runs */}
        <section className="panel p-5">
          <div className="hud mb-3">System runs</div>
          <div className="space-y-2">
            {runs?.length ? runs.map((r) => (
              <div key={r._id} className="flex items-center gap-3 text-sm">
                <span className={`w-1.5 h-1.5 rounded-full ${r.status === "ok" ? "bg-up" : r.status === "running" ? "bg-sky-400 animate-pulse" : "bg-down"}`} />
                <span className="num w-16">{r.kind}</span>
                <span className="text-dim num text-xs">{timeAgo(r.startedAt)}</span>
                <span className="truncate text-dim text-xs">{r.summary?.slice(0, 80)}</span>
              </div>
            )) : <div className="text-dim text-sm">No runs yet — deploy the Trigger tasks.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
