"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "../../convex/_generated/api";
import { Chart, Panel, fmt, ago, compact, type Curve } from "./components/ds";
import { BookProgress, SimpleFunnel, Progression } from "./components/widgets2";

// The HERO page. Deliberately spacious + few things, big + clear. Dense detail
// lives in the sub-pages (Pipeline / Sleeves / Tournament / Data).
export default function Overview() {
  const book = useQuery(api.dashboard.bookStatus, {});
  const flow = useQuery(api.dashboard.stageFlow, {});
  const prog = useQuery(api.dashboard.progression, {});
  const champion = useQuery(api.candidates.champion, {});
  const board = useQuery(api.candidates.tournament, { limit: 1 });
  const runs = useQuery(api.pipeline.recentRuns, { limit: 60 });
  const data = useQuery(api.dashboard.dataSources, {});
  const spxRaw = useQuery(api.pipeline.getConfig, { key: "benchmark_spx" });
  const btcRaw = useQuery(api.pipeline.getConfig, { key: "benchmark_btc" });

  const leader = champion ?? board?.[0];
  const lc: { full?: Curve; wf?: Curve; port?: Curve } = leader?.curves ? safeParse(leader.curves) ?? {} : {};
  const headline = lc.port ?? lc.wf ?? lc.full;
  const spx = rebase(spxRaw, headline);
  const btc = rebase(btcRaw, headline);
  const stratMult = headline?.eq?.length ? headline.eq[headline.eq.length - 1] : undefined;
  const spxMult = spx?.eq?.length ? spx.eq[spx.eq.length - 1] : undefined;
  const btcMult = btc?.eq?.length ? btc.eq[btc.eq.length - 1] : undefined;

  // engine "is it alive" pulse
  const now = Date.now();
  const ideate = (runs ?? []).filter((r) => r.kind === "ideate-opus");
  const evolve = (runs ?? []).filter((r) => r.kind === "evolve");
  const cyclesToday = ideate.filter((r) => now - r.startedAt < 86400_000).length + evolve.filter((r) => now - r.startedAt < 86400_000).length;
  const lastCycle = Math.max(ideate[0]?.startedAt ?? 0, evolve[0]?.startedAt ?? 0);
  const alive = lastCycle > 0 && now - lastCycle < 6 * 3600_000;

  return (
    <div className="space-y-8 stagger pb-10">
      {/* ============ HERO: engine status + the book progress headline ============ */}
      <section className="pt-4">
        <div className="flex items-center gap-2.5 mb-7">
          <span className={`w-2 h-2 rounded-full ${alive ? "bg-up live-dot" : "bg-down"}`} />
          <span className="num text-[11px] text-mid">
            {alive ? "engine live" : "engine idle"} · <span className="text-fg">{cyclesToday}</span> cycles/24h · last <span className="text-fg">{ago(lastCycle)}</span> ago · on <span className="text-promo">Opus</span>
          </span>
        </div>

        {book && (
          <div className="max-w-3xl">
            <div className="hud mb-3">Book progress → promotable</div>
            <BookProgress deflated={book.deflated} target={book.target} raw={book.rawSharpe} divRatio={book.divRatio} meanCorr={book.meanCorr} members={book.nMembers} passes={book.passes} />
          </div>
        )}
      </section>

      {/* ============ big key stats — only 4, large + airy ============ */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-px rounded-2xl overflow-hidden bg-[#ffffff08]">
        <BigStat label="Candidates bred" value={compact(flow?.total)} />
        <BigStat label="In the gauntlet" value={compact(flow?.inGauntlet)} tone="info" />
        <BigStat label="Survivors" value={`${flow?.survivors ?? 0}`} tone={(flow?.survivors ?? 0) > 0 ? "up" : "dim"} />
        <BigStat label="Champions" value={`${flow?.rows.find((r) => r.key === "champion")?.reached ?? 0}`} tone={(flow?.rows.find((r) => r.key === "champion")?.reached ?? 0) > 0 ? "promo" : "dim"} sub="honest 0" />
      </section>

      {/* ============ progression — are we improving over iterations ============ */}
      <Panel title="Tournament progression — best score climbing over iterations" right={<Link href="/tournament" className="num text-[10px] text-dim hover:text-fg">tournament →</Link>} pad="p-6">
        <Progression points={prog?.points ?? []} />
      </Panel>

      {/* ============ equity vs benchmarks ============ */}
      <Panel title="Leader equity vs S&P 500 & BTC buy-hold" right={leader ? <Link href={`/candidates/${leader._id}`} className="num text-[10px] text-dim hover:text-fg">{leader.name} →</Link> : undefined} pad="p-6">
        {headline ? (
          <>
            <Chart height={260} series={[
              { name: "Leader OOS", color: "#3ddb9e", curve: headline },
              ...(spx ? [{ name: "S&P 500", color: "#8b9aab", curve: spx, dash: true }] : []),
              ...(btc ? [{ name: "BTC HODL", color: "#f5b932", curve: btc, dash: true }] : []),
            ]} />
            {stratMult !== undefined && (
              <div className="num text-[12px] text-dim mt-3">
                $10k → <span className="text-up">${(stratMult * 10000).toFixed(0)}</span>
                {spxMult !== undefined && <span className="text-mid"> · S&P ${(spxMult * 10000).toFixed(0)}</span>}
                {btcMult !== undefined && <span className="text-accent"> · BTC ${(btcMult * 10000).toFixed(0)}</span>}
              </div>
            )}
          </>
        ) : <div className="well flex items-center justify-center" style={{ height: 260 }}><span className="hud">no validated curve yet</span></div>}
      </Panel>

      {/* ============ simplified funnel ============ */}
      <Panel title="The gauntlet — what stage everything is at" right={<Link href="/pipeline" className="num text-[10px] text-dim hover:text-fg">pipeline →</Link>} pad="p-6">
        {flow && <SimpleFunnel rows={flow.rows} survivors={flow.survivors} />}
      </Panel>

      {/* ============ minimal system footer ============ */}
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

function safeParse<T>(s: string | undefined | null): T | null { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } }
function rebase(raw: string | null | undefined, headline?: Curve): Curve | undefined {
  if (!raw || !headline?.t?.length) return undefined;
  const b = safeParse<{ t: number[]; c: number[] }>(raw);
  if (!b) return undefined;
  const t0 = headline.t[0], t1 = headline.t[headline.t.length - 1];
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
