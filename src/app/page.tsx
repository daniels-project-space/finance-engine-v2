"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "../../convex/_generated/api";
import { ChartWithBenchmarks, Lead, Info, Spark, pct, curveStats, type Curve } from "./components/ds";

// ================================================================ LIVE (home)
// "How are my strategies doing right now?" The live paper-trading terminal: one
// big plain-English answer, the moving P&L chart vs S&P/BTC, and a card per
// strategy. Daniel's strategy blue-glows. HONEST: real forward paper, ~flat
// because the strategies sit in cash during BTC's downtrend — shown as-is.

function liveAgo(ts?: number): string {
  if (!ts) return "just now";
  const s = (Date.now() - ts) / 1000;
  return s < 90 ? Math.round(s) + "s ago" : s < 5400 ? Math.round(s / 60) + "m ago" : s < 172800 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago";
}

export default function LivePage() {
  const paper = useQuery(api.dashboard.paperBook, {});

  if (!paper) return <div className="hud py-20 text-center">loading…</div>;
  if (paper.nSleeves === 0) {
    return (
      <div className="py-20 text-center">
        <div className="text-[18px] text-mid">No strategies are trading yet.</div>
        <div className="num text-[12px] text-dim mt-2">They start here automatically once they pass testing.</div>
      </div>
    );
  }

  const bookRet = paper.book.ret;
  const curve: Curve | undefined = paper.book.t.length > 1 ? { t: paper.book.t, eq: paper.book.eq } : undefined;
  const cs = curveStats(curve, 8760); // hourly paper steps
  const inCash = paper.sleeves.filter((s) => Math.abs(s.ret) < 0.0005 && !s.halted).length;
  const trading = paper.nSleeves - inCash;
  const flatBook = Math.abs(bookRet) < 0.002;
  void cs;

  return (
    <div className="space-y-7 stagger pb-14">
      {/* ============ the plain-English answer ============ */}
      <Lead dot="live">
        Your strategies are being tested with <span className="text-fg">fake money on live prices</span>.{" "}
        {flatBook
          ? <>Right now most are <span className="text-fg">sitting in cash</span>, waiting for an uptrend — so the line is flat. That&apos;s the safety filter working, not a frozen screen.</>
          : <>They&apos;re up <span className={bookRet >= 0 ? "text-up" : "text-down"}>{(bookRet * 100).toFixed(2)}%</span> so far.</>}
      </Lead>

      {/* ============ THE BIG NUMBER + BIG MOVING CHART ============ */}
      <section className="grid lg:grid-cols-[0.8fr_1.5fr] gap-6 items-stretch">
        {/* big P&L block — the ONE number, big */}
        <div className="panel p-7 flex flex-col justify-center">
          <div className="hud mb-2">Profit so far (fake money)</div>
          <div className={`num leading-none ${bookRet >= 0 ? "text-up" : "text-down"}`} style={{ fontSize: 80 }}>
            {bookRet >= 0 ? "+" : ""}{(bookRet * 100).toFixed(2)}%
          </div>
          <div className="num text-[11px] text-dim mt-3">updated {liveAgo(paper.book.lastTs)} · checks every hour</div>
          {/* a few supporting numbers, small */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 mt-7 pt-6 border-t border-edge/50">
            <div><div className="hud mb-1">Strategies</div><div className="num text-[20px] text-accent">{paper.nSleeves}</div></div>
            <div><div className="hud mb-1">Trading now</div><div className="num text-[20px] text-fg">{trading} <span className="text-dim text-[12px]">/ {inCash} in cash</span></div></div>
            <div><div className="hud mb-1">Days running</div><div className="num text-[20px] text-fg">{paper.days.toFixed(0)}</div></div>
            <div><div className="hud mb-1 flex items-center">Worst dip<Info>Max drawdown — the biggest drop from a peak so far.</Info></div><div className="num text-[20px] text-down">{pct(paper.book.maxDD, 1)}</div></div>
          </div>
        </div>

        {/* big moving equity chart + 3-way metrics */}
        <div className="panel p-6 min-w-0">
          <div className="flex items-center justify-between mb-3">
            <span className="hud">How the money has moved</span>
            <span className="num text-[10px] blue-glow-text">● LIVE {liveAgo(paper.book.lastTs)}</span>
          </div>
          {curve ? (
            <ChartWithBenchmarks
              height={320}
              yLabel="growth of $1"
              storeKey="live-book"
              stratLabel="your strategies"
              ppy={8760}
              showMetrics
              series={[{ name: "your strategies", color: bookRet >= 0 ? "#3ddb9e" : "#fb6f5d", curve }]}
            />
          ) : (
            <div className="well flex items-center justify-center" style={{ height: 300 }}>
              <span className="hud">{paper.book.bars === 0 ? "positions set — profit starts from the next hour" : "gathering data…"}</span>
            </div>
          )}
        </div>
      </section>

      {/* ============ PER-STRATEGY CARDS ============ */}
      <div>
        <div className="hud mb-3">Each strategy right now</div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {paper.sleeves.map((s) => {
            const glow = s.userStrategy || s.source === "regime";
            const flat = Math.abs(s.ret) < 0.0005;
            return (
              <Link key={s.id} href={`/candidates/${s.id}`}
                className={`panel panel-h p-5 block ${glow ? "blue-glow" : ""}`}>
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="min-w-0">
                    <div className={`num text-[12px] truncate ${glow ? "blue-glow-text" : "text-mid"}`}>{s.name}</div>
                    {glow && <div className="num text-[9px] blue-glow-text mt-0.5">★ your strategy</div>}
                  </div>
                  <span className={`num text-[9px] px-2 py-0.5 rounded shrink-0 ${s.halted ? "text-down bg-[#fb6f5d18]" : flat ? "text-dim bg-[#ffffff08]" : "text-up bg-[#3ddb9e18]"}`}>
                    {s.halted ? "stopped" : flat ? "in cash" : "trading"}
                  </span>
                </div>
                <div className={`num text-[32px] leading-none ${s.ret >= 0 ? "text-up" : "text-down"}`}>
                  {s.ret >= 0 ? "+" : ""}{(s.ret * 100).toFixed(2)}%
                </div>
                <div className="mt-4 h-[28px]">
                  {s.spark.length > 1 ? <Spark values={s.spark} width={240} height={28} tone={s.ret >= 0 ? "up" : "down"} fill /> : <span className="hud">—</span>}
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      <div className="flex justify-center pt-2">
        <Link href="/strategies" className="num text-[12px] text-dim hover:text-fg">see the best strategies →</Link>
      </div>
    </div>
  );
}
