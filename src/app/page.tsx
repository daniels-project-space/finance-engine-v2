"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "../../convex/_generated/api";
import { Chart, Panel, fmt, pct, ago, compact, type Curve } from "./components/ds";
import { PaperBook, BookProgress, SimpleFunnel, Progression, TrendVsHodl } from "./components/widgets2";

// HERO page. The headline is now the LIVE PAPER FORWARD track record — a moving
// number that accumulates over time — with the strict backtest bar kept secondary.
export default function Overview() {
  const paper = useQuery(api.dashboard.paperBook, {});
  const trendHodl = useQuery(api.dashboard.trendVsHodl, {});
  const book = useQuery(api.dashboard.bookStatus, {});
  const flow = useQuery(api.dashboard.stageFlow, {});
  const prog = useQuery(api.dashboard.progression, {});
  const runs = useQuery(api.pipeline.recentRuns, { limit: 60 });
  const data = useQuery(api.dashboard.dataSources, {});

  // engine "is it alive" pulse
  const now = Date.now();
  const ideate = (runs ?? []).filter((r) => r.kind === "ideate-opus");
  const evolve = (runs ?? []).filter((r) => r.kind === "evolve");
  const paperRuns = (runs ?? []).filter((r) => r.kind === "paper-step" || r.kind === "paper");
  const cyclesToday = ideate.filter((r) => now - r.startedAt < 86400_000).length + evolve.filter((r) => now - r.startedAt < 86400_000).length;
  const lastCycle = Math.max(ideate[0]?.startedAt ?? 0, evolve[0]?.startedAt ?? 0);
  const alive = lastCycle > 0 && now - lastCycle < 6 * 3600_000;

  return (
    <div className="space-y-8 stagger pb-10">
      {/* ============ engine pulse ============ */}
      <section className="pt-4">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className={`w-2 h-2 rounded-full ${alive ? "bg-up live-dot" : "bg-down"}`} />
          <span className="num text-[11px] text-mid">
            {alive ? "engine live" : "engine idle"} · <span className="text-fg">{cyclesToday}</span> cycles/24h · last <span className="text-fg">{ago(lastCycle)}</span> ago · on <span className="text-promo">Opus</span>
            {" · "}paper forward-test <span className={paperRuns.length ? "text-up" : "text-dim"}>{paperRuns.length ? "running" : "hourly"}</span>
          </span>
        </div>
      </section>

      {/* ============ HERO: the LIVE PAPER FORWARD TRACK RECORD (the moving headline) ============ */}
      <Panel pad="p-6" title="Paper book — live forward track record (simulated, no real money)"
        right={<Link href="/tournament" className="num text-[10px] text-dim hover:text-fg">sleeves →</Link>}>
        {paper && <PaperBook data={paper} />}
      </Panel>

      {/* ============ SAFER THAN HODL: trend-beta vs BTC buy-and-hold drawdown ============ */}
      {trendHodl && (
        <Panel pad="p-6" title="Risk-managed beta — safer than holding BTC (backtest)">
          <TrendVsHodl data={trendHodl} />
        </Panel>
      )}

      {/* ============ big key stats ============ */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-px rounded-2xl overflow-hidden bg-[#ffffff08]">
        <BigStat label="Sleeves in paper" value={`${paper?.nSleeves ?? 0}`} tone={(paper?.nSleeves ?? 0) > 0 ? "accent" : "dim"} />
        <BigStat label="Candidates bred" value={compact(flow?.total)} />
        <BigStat label="In the gauntlet" value={compact(flow?.inGauntlet)} tone="info" />
        <BigStat label="Champions (real money)" value={`${flow?.rows.find((r) => r.key === "champion")?.reached ?? 0}`} tone={(flow?.rows.find((r) => r.key === "champion")?.reached ?? 0) > 0 ? "promo" : "dim"} sub="strict bar — honest 0" />
      </section>

      {/* ============ progression ============ */}
      <Panel title="Tournament progression — best score climbing over iterations" right={<Link href="/tournament" className="num text-[10px] text-dim hover:text-fg">tournament →</Link>} pad="p-6">
        <Progression points={prog?.points ?? []} />
      </Panel>

      {/* ============ the strict backtest bar (now secondary context) ============ */}
      <Panel pad="p-6" title="Backtest book — the strict real-money bar (secondary)">
        {book && (
          <div className="max-w-2xl">
            <BookProgress deflated={book.deflated} target={book.target} raw={book.rawSharpe} divRatio={book.divRatio} meanCorr={book.meanCorr} members={book.nMembers} passes={book.passes} />
            <p className="num text-[10px] text-dim mt-4 leading-relaxed">
              Real-money promotion still requires the deflated-Sharpe ≥ 1.00 book bar OR a proven forward paper track record (≥30d forward-positive) AND human approval. We forward-test liberally on paper; we promote to real money strictly.
            </p>
          </div>
        )}
      </Panel>

      {/* ============ funnel ============ */}
      <Panel title="The gauntlet — what stage everything is at" right={<Link href="/pipeline" className="num text-[10px] text-dim hover:text-fg">pipeline →</Link>} pad="p-6">
        {flow && <SimpleFunnel rows={flow.rows} survivors={flow.survivors} />}
      </Panel>

      {/* ============ footer ============ */}
      <div className="flex flex-wrap gap-x-8 gap-y-2 items-center justify-center num text-[11px] text-dim pt-2">
        <span>universe <span className="text-fg">{data?.price.symbols ?? "·"}×{data?.price.tfs.length ?? "·"}tf</span></span>
        <span>data <span className={Date.now() - (data?.price.lastTs ?? 0) < 2.5 * 3600_000 ? "text-up" : "text-down"}>{data?.price.lastTs ? ago(data.price.lastTs) + " ago" : "·"}</span></span>
        <span>5 data feeds <span className="text-up">live</span></span>
        <Link href="/data" className="hover:text-fg">data & system →</Link>
      </div>
    </div>
  );
}

function BigStat({ label, value, tone = "fg", sub }: { label: string; value: string; tone?: "fg" | "up" | "down" | "dim" | "info" | "promo" | "accent"; sub?: string }) {
  const c = tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "dim" ? "text-dim" : tone === "info" ? "text-info" : tone === "promo" ? "text-promo" : tone === "accent" ? "text-accent" : "text-fg";
  return (
    <div className="bg-panel px-6 py-7">
      <div className="hud mb-3">{label}</div>
      <div className={`num text-[40px] leading-none ${c}`}>{value}</div>
      {sub && <div className="num text-[10px] text-dim mt-2">{sub}</div>}
    </div>
  );
}
