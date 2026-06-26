"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "../../../convex/_generated/api";
import { ChartWithBenchmarks, ThreeWayMetrics, Spark, fmt, pct, curveStats, type Curve } from "../components/ds";

// ================================================================ LIVE TERMINAL
// The dedicated live-paper-trading page — the visual centerpiece. Big moving
// forward-equity chart (auto-updates via Convex reactivity) with SPX/BTC overlay,
// big P&L / Sharpe / drawdown / win-rate / days, and per-sleeve LIVE cards
// (Daniel's blue-glow strategies highlighted). HONEST: P&L is real forward paper,
// currently ~flat since sleeves sit in cash during BTC's downtrend — shown as-is.

function liveAgo(ts?: number): string {
  if (!ts) return "—";
  const s = (Date.now() - ts) / 1000;
  return s < 90 ? Math.round(s) + "s ago" : s < 5400 ? Math.round(s / 60) + "m ago" : s < 172800 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago";
}

export default function LivePage() {
  const paper = useQuery(api.dashboard.paperBook, {});

  if (!paper) return <div className="hud py-20 text-center">loading live book…</div>;
  if (paper.nSleeves === 0) {
    return (
      <div className="py-20 text-center">
        <div className="num text-[16px] text-mid">No sleeves trading live yet.</div>
        <div className="num text-[11px] text-dim mt-2">Honest sleeves route here automatically once they pass the significance battery.</div>
      </div>
    );
  }

  const bookRet = paper.book.ret;
  const curve: Curve | undefined = paper.book.t.length > 1 ? { t: paper.book.t, eq: paper.book.eq } : undefined;
  const warming = (paper.book.bars ?? 0) <= 48;
  const cs = curveStats(curve, 8760); // hourly paper steps
  const lastTs = paper.book.lastTs;
  const winners = paper.sleeves.filter((s) => s.ret > 0).length;
  const live = paper.sleeves.filter((s) => !s.halted).length;

  return (
    <div className="space-y-6 stagger pb-12">
      {/* ============ terminal header ============ */}
      <div className="flex items-center justify-between flex-wrap gap-3 pt-2">
        <div className="flex items-center gap-2.5">
          <span className="w-2.5 h-2.5 rounded-full bg-info live-dot" />
          <span className="num text-[13px] blue-glow-text tracking-[0.2em]">LIVE PAPER TRADING</span>
          <span className="num text-[10px] text-dim">simulated forward-test · no real money</span>
        </div>
        <span className="num text-[10px] text-dim">updated {liveAgo(lastTs)} · steps hourly · auto-updating</span>
      </div>

      {/* ============ THE BIG NUMBER + BIG MOVING CHART ============ */}
      <section className="grid lg:grid-cols-[0.85fr_1.4fr] gap-6 items-stretch">
        {/* big P&L block */}
        <div className="panel p-7 flex flex-col justify-center">
          <div className="hud mb-2">Forward P&amp;L · combined book</div>
          <div className={`num leading-none ${bookRet >= 0 ? "text-up" : "text-down"}`} style={{ fontSize: 76 }}>
            {bookRet >= 0 ? "+" : ""}{(bookRet * 100).toFixed(2)}%
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-5 mt-7">
            <div><div className="hud mb-1.5">Forward Sharpe</div><div className={`num text-[24px] ${warming ? "text-dim" : (paper.book.sharpe ?? 0) > 0 ? "text-up" : "text-down"}`}>{warming ? "warming" : fmt(paper.book.sharpe)}</div></div>
            <div><div className="hud mb-1.5">Forward maxDD</div><div className="num text-[24px] text-down">{pct(paper.book.maxDD, 1)}</div></div>
            <div><div className="hud mb-1.5">Days running</div><div className="num text-[24px] text-fg">{paper.days.toFixed(1)}</div></div>
            <div><div className="hud mb-1.5">Win rate</div><div className="num text-[24px] text-mid">{cs.winRate == null ? "—" : pct(cs.winRate, 0)}</div></div>
          </div>
          <div className="mt-7 pt-5 border-t border-edge/50 flex items-center gap-5 num text-[11px]">
            <span className="text-dim">sleeves <span className="text-accent text-[15px]">{paper.nSleeves}</span></span>
            <span className="text-dim">live <span className="text-up text-[15px]">{live}</span></span>
            <span className="text-dim">in profit <span className={winners ? "text-up text-[15px]" : "text-dim text-[15px]"}>{winners}</span></span>
          </div>
        </div>

        {/* big moving equity chart + 3-way metrics */}
        <div className="panel p-6 min-w-0">
          <div className="flex items-center justify-between mb-3">
            <span className="hud">Live forward equity — extends each hour</span>
            <span className="num text-[10px] blue-glow-text">● LIVE {liveAgo(lastTs)}</span>
          </div>
          {curve ? (
            <ChartWithBenchmarks
              height={300}
              yLabel="growth of $1 (forward)"
              storeKey="live-book"
              stratLabel="paper book (forward)"
              ppy={8760}
              showMetrics
              series={[{ name: "paper book (forward)", color: bookRet >= 0 ? "#3ddb9e" : "#fb6f5d", curve }]}
            />
          ) : (
            <div className="well flex items-center justify-center" style={{ height: 280 }}>
              <span className="hud">{paper.book.bars === 0 ? "positions set — P&L accrues from next bar" : "accumulating forward bars…"}</span>
            </div>
          )}
        </div>
      </section>

      {/* ============ honest note ============ */}
      <p className="num text-[11px] text-dim leading-relaxed max-w-3xl">
        Real forward-test on unseen live data. The book is currently near-flat because the sleeves are mostly <span className="text-mid">in cash</span> during BTC&apos;s downtrend (the chop-gated / trend sleeves go to cash below their moving average) — that is the regime filter working, not a stalled feed. The record builds as positions re-engage. These are modest, honest sleeves (passed bootstrap-CI&gt;0, deflated&gt;0, perm/PBO), not proven alpha.
      </p>

      {/* ============ PER-SLEEVE LIVE CARDS ============ */}
      <div>
        <div className="hud mb-3">Live sleeves — forward P&amp;L per strategy</div>
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
                    <div className="num text-[9px] text-dim mt-0.5">{s.family}{s.leverage && s.leverage > 1 ? ` · ${s.leverage}x` : ""}</div>
                  </div>
                  <span className={`num text-[8px] px-1.5 py-0.5 rounded shrink-0 ${s.halted ? "text-down bg-[#fb6f5d18]" : flat ? "text-dim bg-[#ffffff08]" : "text-up bg-[#3ddb9e18]"}`}>
                    {s.halted ? "halted" : flat ? "in cash" : "long"}
                  </span>
                </div>
                <div className={`num text-[30px] leading-none ${s.ret >= 0 ? "text-up" : "text-down"}`}>
                  {s.ret >= 0 ? "+" : ""}{(s.ret * 100).toFixed(2)}%
                </div>
                <div className="mt-3.5 h-[26px]">
                  {s.spark.length > 1 ? <Spark values={s.spark} width={240} height={26} tone={s.ret >= 0 ? "up" : "down"} fill /> : <span className="hud">—</span>}
                </div>
                <div className="flex items-center justify-between mt-3.5 pt-3 border-t border-edge/40 num text-[10px] text-dim">
                  <span>Sharpe <span className={s.sharpe == null ? "text-dim" : s.sharpe > 0 ? "text-up" : "text-down"}>{s.sharpe == null ? "·" : fmt(s.sharpe)}</span></span>
                  <span>DD <span className="text-down">{pct(s.maxDD, 0)}</span></span>
                  <span>{s.days.toFixed(1)}d</span>
                  {glow && <span className="blue-glow-text">★</span>}
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      <div className="flex justify-center pt-2">
        <Link href="/tournament" className="num text-[11px] text-dim hover:text-fg">backtest leaderboard →</Link>
      </div>
    </div>
  );
}
