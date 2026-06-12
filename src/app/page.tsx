"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "../../convex/_generated/api";
import { LineChart, MiniCurve, type Curve } from "./components/charts";
import { StageBadge, Stat, fmtNum, fmtPct, timeAgo } from "./components/ui";
import {
  ActivityFeed, GauntletFunnel, KillBars, ProgressionChart, SOURCE_COLORS,
  SourceAttribution, TargetGauge, type ActivityItem,
} from "./components/widgets";

const TARGET_COMPOSITE = 1.04; // 2× the 0.52 board record at mandate time

export default function Overview() {
  const champion = useQuery(api.candidates.champion, {});
  const board = useQuery(api.candidates.tournament, { limit: 12 });
  const analytics = useQuery(api.candidates.analytics, {});
  const funnel = useQuery(api.candidates.funnel, {});
  const runs = useQuery(api.pipeline.recentRuns, { limit: 12 });
  const lessons = useQuery(api.pipeline.recentLessons, { limit: 12 });
  const promotions = useQuery(api.promotions.history, { limit: 6 });
  const datasets = useQuery(api.pipeline.listDatasets, {});
  const trials = useQuery(api.pipeline.getCounter, { key: "trials_total" });
  const llmSpend = useQuery(api.pipeline.getCounter, { key: `llm_usd_cents:${new Date().toISOString().slice(0, 10)}` });

  const leader = champion ?? board?.[0];
  const leaderMetrics = leader?.metrics ? (JSON.parse(leader.metrics) as Record<string, number>) : {};
  let leaderCurves: { full?: Curve; wf?: Curve; port?: Curve; sealed?: Curve } = {};
  try { leaderCurves = leader?.curves ? JSON.parse(leader.curves) : {}; } catch {}
  const bestComposite = Math.max(0, ...(board ?? []).map((b) => b.composite ?? 0));

  const alive = funnel ? (funnel.incubating ?? 0) + (funnel.eligible ?? 0) + (funnel.champion ?? 0) + (funnel.sealed_passed ?? 0) : 0;

  // merged activity feed
  const activity: ActivityItem[] = [];
  for (const r of runs ?? []) {
    activity.push({
      ts: r.startedAt, kind: r.kind,
      text: r.status === "running" ? "running…" : (r.summary ?? r.status).slice(0, 110),
      tone: r.status === "error" ? "down" : "dim",
    });
  }
  for (const l of lessons ?? []) {
    activity.push({ ts: l.createdAt, kind: "lesson", text: l.text.slice(0, 120), tone: l.text.startsWith("PASSED") ? "up" : "dim" });
  }
  for (const p of promotions ?? []) {
    activity.push({ ts: p.createdAt, kind: p.action, text: p.note ?? "", tone: p.action === "promote" ? "gold" : "down" });
  }
  activity.sort((a, b) => b.ts - a.ts);

  const dataFresh = datasets?.length
    ? Math.max(...datasets.map((d) => d.lastTs))
    : 0;
  const evolving = (runs ?? []).some((r) => r.status === "running");

  return (
    <div className="space-y-5">
      {/* ============ hero: leader + mandate ============ */}
      <section className="panel p-6 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(1200px 280px at 20% -40%, #e8b34b14, transparent)" }} />
        <div className="grid lg:grid-cols-[1.2fr_1fr] gap-8 relative">
          <div>
            <div className="hud mb-2 flex items-center gap-2">
              {champion ? "live champion" : "board leader (nobody has earned the crown yet)"}
              {evolving && <span className="inline-flex items-center gap-1 text-up normal-case tracking-normal"><span className="w-1.5 h-1.5 rounded-full bg-up animate-pulse" />evolving</span>}
            </div>
            {leader ? (
              <>
                <div className="flex items-center gap-3 flex-wrap">
                  <Link href={`/candidates/${leader._id}`} className="text-2xl font-semibold text-gold hover:underline">{leader.name}</Link>
                  <StageBadge stage={leader.stage} />
                  <span className="num text-[10px] px-1.5 py-0.5 rounded border border-edge" style={{ color: SOURCE_COLORS[leader.source] }}>{leader.source}</span>
                </div>
                <p className="text-dim text-sm mt-2 max-w-xl leading-relaxed">{leader.hypothesis.slice(0, 220)}</p>
                <div className="flex gap-7 mt-5 flex-wrap">
                  <Stat label="Composite" value={fmtNum(leader.composite)} tone="gold" />
                  <Stat label="BTC WF Sharpe" value={fmtNum(leaderMetrics.wfPooledSharpe)} />
                  <Stat label="Portfolio OOS" value={fmtNum(leaderMetrics.portOosSharpe)} tone={leaderMetrics.portOosSharpe > 0 ? "up" : undefined} />
                  <Stat label="Max DD" value={fmtPct(leaderMetrics.fullMaxDD, 0)} tone={(leaderMetrics.fullMaxDD ?? 0) < -0.25 ? "down" : undefined} />
                  <Stat label="Win rate" value={fmtPct(leaderMetrics.winRate, 0)} />
                  <Stat label="CAGR" value={fmtPct(leaderMetrics.fullCagr, 0)} tone={(leaderMetrics.fullCagr ?? 0) > 0 ? "up" : "down"} />
                </div>
              </>
            ) : <div className="text-dim">No scored candidates yet.</div>}
            <div className="mt-6 max-w-md">
              <TargetGauge current={bestComposite} target={TARGET_COMPOSITE} label="Mandate progress — best composite" />
            </div>
          </div>
          <div className="min-w-0">
            {(leaderCurves.wf || leaderCurves.full) && (
              <LineChart series={[
                ...(leaderCurves.port ? [{ name: "portfolio OOS", color: "#e8b34b", curve: leaderCurves.port }] : []),
                ...(leaderCurves.wf ? [{ name: "BTC WF OOS", color: "#2dd4a7", curve: leaderCurves.wf }] : []),
                ...(leaderCurves.full ? [{ name: "full backtest", color: "#5aa9e6", curve: leaderCurves.full }] : []),
              ]} height={230} />
            )}
          </div>
        </div>
      </section>

      {/* ============ iteration progression ============ */}
      <section className="panel p-5">
        <div className="flex items-baseline justify-between flex-wrap gap-2 mb-2">
          <div className="hud">Iteration progression — every scored candidate, and the record line</div>
          <div className="flex gap-3 flex-wrap">
            {Object.entries(SOURCE_COLORS).map(([s, c]) => (
              <span key={s} className="num text-[10px]" style={{ color: c }}>● {s}</span>
            ))}
          </div>
        </div>
        <ProgressionChart points={analytics?.progression ?? []} target={TARGET_COMPOSITE} />
      </section>

      {/* ============ middle row: funnel / attribution / kills ============ */}
      <div className="grid md:grid-cols-3 gap-5">
        <section className="panel p-5">
          <div className="hud mb-3">The gauntlet — reached / killed per stage</div>
          {analytics && <GauntletFunnel kills={analytics.killsByStage} alive={alive} total={analytics.total} />}
          <div className="num text-[10px] text-dim mt-3">{analytics?.total ?? 0} candidates ever · floors never bend</div>
        </section>
        <section className="panel p-5">
          <div className="hud mb-3">Lane attribution — best composite by origin</div>
          {analytics && <SourceAttribution stats={analytics.sourceStats} />}
        </section>
        <section className="panel p-5">
          <div className="hud mb-3">Where strategies die</div>
          {analytics && <KillBars kills={analytics.killsByStage} />}
        </section>
      </div>

      {/* ============ leaderboard + activity ============ */}
      <div className="grid lg:grid-cols-[1.4fr_1fr] gap-5">
        <section className="panel p-5">
          <div className="flex justify-between items-baseline mb-3">
            <div className="hud">Leaderboard</div>
            <Link href="/tournament" className="num text-xs text-dim hover:text-fg">full tournament →</Link>
          </div>
          <div className="space-y-1">
            {(board ?? []).slice(0, 8).map((c, i) => {
              const m = c.metrics ? JSON.parse(c.metrics) as Record<string, number> : {};
              let wf: Curve | undefined;
              try { wf = c.curves ? (JSON.parse(c.curves) as { wf?: Curve }).wf : undefined; } catch {}
              return (
                <Link key={c._id} href={`/candidates/${c._id}`} className="flex items-center gap-3 text-sm hover:bg-edge/30 rounded px-2 py-1.5">
                  <span className={`num w-6 text-center ${i === 0 ? "text-gold text-base" : "text-dim"}`}>{i + 1}</span>
                  <span className="truncate flex-1">
                    {c.name}
                    <span className="num text-[10px] ml-2" style={{ color: SOURCE_COLORS[c.source] }}>{c.source}</span>
                  </span>
                  <MiniCurve curve={wf} width={90} height={26} />
                  <span className="num text-right w-14 text-gold">{fmtNum(c.composite)}</span>
                  <span className="num text-right w-14 text-dim">{fmtNum(m.wfPooledSharpe)}</span>
                </Link>
              );
            })}
            {!board?.length && <div className="hud py-6 text-center">empty board</div>}
          </div>
        </section>
        <section className="panel p-5">
          <div className="hud mb-3">Live activity</div>
          <ActivityFeed items={activity.slice(0, 24)} />
        </section>
      </div>

      {/* ============ system strip ============ */}
      <section className="panel px-5 py-3 flex flex-wrap gap-x-8 gap-y-2 items-center">
        <span className="hud">system</span>
        <span className="num text-xs text-dim">trials <span className="text-fg">{trials ?? "·"}</span></span>
        <span className="num text-xs text-dim">candidates <span className="text-fg">{analytics?.total ?? "·"}</span></span>
        <span className="num text-xs text-dim">LLM today <span className="text-fg">${((llmSpend ?? 0) / 100).toFixed(2)}</span></span>
        <span className="num text-xs text-dim">data <span className={Date.now() - dataFresh < 2.5 * 3600_000 ? "text-up" : "text-down"}>{dataFresh ? timeAgo(dataFresh) : "·"}</span></span>
        <span className="num text-xs text-dim">universe <span className="text-fg">{datasets ? new Set(datasets.map((d) => d.symbol)).size : "·"} pairs × {datasets ? new Set(datasets.map((d) => d.tf)).size : "·"} tf</span></span>
        <span className="num text-xs text-dim ml-auto">evolve :20/3h · fable :50/3h · paper :12 · monitor 07:00 UTC</span>
      </section>
    </div>
  );
}
