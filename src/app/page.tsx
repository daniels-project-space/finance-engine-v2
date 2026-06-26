"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "../../convex/_generated/api";
import { compact, ago } from "./components/ds";
import { TrendVsHodl } from "./components/widgets2";

// OVERVIEW — deliberately lean. The live forward track record now lives on the
// dedicated /live tab (the rich one); this page is the calm summary: engine pulse,
// the one headline story (risk-managed beta vs HODL), four key stats, and a single
// CTA into Live. Everything secondary moved to its own page.
export default function Overview() {
  const paper = useQuery(api.dashboard.paperBook, {});
  const trendHodl = useQuery(api.dashboard.trendVsHodl, {});
  const flow = useQuery(api.dashboard.stageFlow, {});
  const runs = useQuery(api.pipeline.recentRuns, { limit: 60 });

  const now = Date.now();
  const ideate = (runs ?? []).filter((r) => r.kind === "ideate-opus");
  const evolve = (runs ?? []).filter((r) => r.kind === "evolve");
  const cyclesToday = ideate.filter((r) => now - r.startedAt < 86400_000).length + evolve.filter((r) => now - r.startedAt < 86400_000).length;
  const lastCycle = Math.max(ideate[0]?.startedAt ?? 0, evolve[0]?.startedAt ?? 0);
  const alive = lastCycle > 0 && now - lastCycle < 6 * 3600_000;
  const bookRet = paper?.book.ret ?? 0;
  const champions = flow?.rows.find((r) => r.key === "champion")?.reached ?? 0;

  return (
    <div className="space-y-8 stagger pb-12">
      {/* ============ engine pulse ============ */}
      <section className="pt-4 flex items-center gap-2.5 flex-wrap">
        <span className={`w-2 h-2 rounded-full ${alive ? "bg-up live-dot" : "bg-down"}`} />
        <span className="num text-[11px] text-mid">
          {alive ? "engine live" : "engine idle"} · <span className="text-fg">{cyclesToday}</span> cycles/24h · last <span className="text-fg">{ago(lastCycle)}</span> ago · on <span className="text-promo">Opus</span>
        </span>
      </section>

      {/* ============ LIVE CTA — the headline lives on its own tab now ============ */}
      <Link href="/live" className="panel panel-h p-6 flex items-center justify-between gap-5 block">
        <div className="flex items-center gap-4">
          <span className="w-2.5 h-2.5 rounded-full bg-info live-dot shrink-0" />
          <div>
            <div className="num text-[11px] blue-glow-text tracking-wider mb-1">LIVE PAPER BOOK</div>
            <div className="num text-[13px] text-dim">{paper ? `${paper.nSleeves} sleeves forward-testing · ${paper.days.toFixed(0)}d` : "loading…"}</div>
          </div>
        </div>
        <div className="flex items-center gap-5">
          <div className="text-right">
            <div className="hud mb-1">forward P&amp;L</div>
            <div className={`num text-[34px] leading-none ${bookRet >= 0 ? "text-up" : "text-down"}`}>{bookRet >= 0 ? "+" : ""}{(bookRet * 100).toFixed(2)}%</div>
          </div>
          <span className="num text-[11px] text-dim">open Live →</span>
        </div>
      </Link>

      {/* ============ THE ONE STORY: risk-managed beta vs holding BTC ============ */}
      {trendHodl && (
        <section className="panel p-6">
          <div className="hud mb-4">Risk-managed beta — safer than holding BTC (backtest)</div>
          <TrendVsHodl data={trendHodl} />
        </section>
      )}

      {/* ============ four key stats ============ */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-px rounded-2xl overflow-hidden bg-[#ffffff08]">
        <BigStat label="Sleeves in paper" value={`${paper?.nSleeves ?? 0}`} tone={(paper?.nSleeves ?? 0) > 0 ? "accent" : "dim"} />
        <BigStat label="Candidates bred" value={compact(flow?.total)} />
        <BigStat label="In the gauntlet" value={compact(flow?.inGauntlet)} tone="info" />
        <BigStat label="Champions (real money)" value={`${champions}`} tone={champions > 0 ? "promo" : "dim"} sub="strict bar — honest 0" />
      </section>

      {/* ============ lean nav footer ============ */}
      <div className="flex flex-wrap gap-x-7 gap-y-2 items-center justify-center num text-[11px] text-dim pt-2">
        <Link href="/live" className="blue-glow-text hover:underline">live book →</Link>
        <Link href="/tournament" className="hover:text-fg">leaderboard →</Link>
        <Link href="/pipeline" className="hover:text-fg">gauntlet →</Link>
        <Link href="/sleeves" className="hover:text-fg">sleeves →</Link>
        <Link href="/data" className="hover:text-fg">data →</Link>
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
