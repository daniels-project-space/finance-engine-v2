"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "../../convex/_generated/api";
import { Chart, Panel, Stat, StageBadge, Pill, fmt, pct, ago, compact, type Curve } from "./components/ds";
import { Funnel, BookGauge, Attribution, ActivityFeed, srcColor, type ActivityItem } from "./components/widgets2";

export default function Overview() {
  const book = useQuery(api.dashboard.bookStatus, {});
  const flow = useQuery(api.dashboard.stageFlow, {});
  const families = useQuery(api.dashboard.sleeveFamilies, {});
  const champion = useQuery(api.candidates.champion, {});
  const board = useQuery(api.candidates.tournament, { limit: 10 });
  const analytics = useQuery(api.candidates.analytics, {});
  const runs = useQuery(api.pipeline.recentRuns, { limit: 14 });
  const lessons = useQuery(api.pipeline.recentLessons, { limit: 14 });
  const promotions = useQuery(api.promotions.history, { limit: 6 });
  const data = useQuery(api.dashboard.dataSources, {});
  const trials = useQuery(api.pipeline.getCounter, { key: "trials_total" });
  const llm = useQuery(api.pipeline.getCounter, { key: `llm_usd_cents:${new Date().toISOString().slice(0, 10)}` });
  const spxRaw = useQuery(api.pipeline.getConfig, { key: "benchmark_spx" });
  const btcRaw = useQuery(api.pipeline.getConfig, { key: "benchmark_btc" });

  const leader = champion ?? board?.[0];
  const lm = leader?.metrics ? safeParse<Record<string, number>>(leader.metrics) ?? {} : {};
  const lc = leader?.curves ? safeParse<{ full?: Curve; wf?: Curve; port?: Curve; sealed?: Curve }>(leader.curves) ?? {} : {};
  const headline = lc.port ?? lc.wf ?? lc.full;

  const spx = rebase(spxRaw, headline);
  const btc = rebase(btcRaw, headline);
  const stratMult = headline?.eq?.length ? headline.eq[headline.eq.length - 1] : undefined;
  const spxMult = spx?.eq?.length ? spx.eq[spx.eq.length - 1] : undefined;
  const btcMult = btc?.eq?.length ? btc.eq[btc.eq.length - 1] : undefined;
  const headlineLabel = lc.port ? "Leader OOS" : lc.wf ? "Leader WF OOS" : "Leader";

  const running = (runs ?? []).some((r) => r.status === "running");

  // merged activity
  const activity: ActivityItem[] = [];
  for (const r of runs ?? []) activity.push({ ts: r.startedAt, kind: r.kind, text: r.status === "running" ? "running…" : (r.summary ?? r.status).slice(0, 110), tone: r.status === "error" ? "down" : "dim" });
  for (const l of lessons ?? []) activity.push({ ts: l.createdAt, kind: "lesson", text: l.text.slice(0, 120), tone: l.text.startsWith("PASSED") ? "up" : "dim" });
  for (const p of promotions ?? []) activity.push({ ts: p.createdAt, kind: p.action, text: p.note ?? "", tone: p.action === "promote" ? "accent" : "down" });
  activity.sort((a, b) => b.ts - a.ts);

  const dataFresh = data?.price.lastTs ?? 0;
  const survivors = flow?.survivors ?? 0;

  return (
    <div className="space-y-4 stagger">
      {/* ============================== BOOK STATUS — the headline ============================== */}
      <Panel pad="p-5">
        <div className="grid lg:grid-cols-[1fr_1.05fr] gap-7">
          {/* left: the promotability story */}
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-3">
              <span className="hud">Diversification book — promotability</span>
              {running && <span className="num text-[9px] text-up flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-up live-dot" />evolving</span>}
            </div>
            {book && (
              <>
                <div className="flex items-end gap-6 mb-4">
                  <Stat label="Deflated Sharpe" value={fmt(book.deflated)} tone={book.passes ? "up" : "accent"} size="lg" sub={`needs ${fmt(book.target)} to promote`} />
                  <Stat label="Raw book Sharpe" value={fmt(book.rawSharpe)} tone="fg" />
                  <Stat label="Div. ratio" value={fmt(book.divRatio)} tone={book.divRatio > 1 ? "info" : "dim"} sub=">1 = diversified" />
                  <Stat label="Mean |corr|" value={fmt(book.meanCorr)} tone={book.meanCorr <= 0.5 ? "up" : "down"} sub="≤0.50 cap" />
                </div>
                <BookGauge deflated={book.deflated} target={book.target} raw={book.rawSharpe} />
                <div className="mt-4 flex items-center gap-2 flex-wrap">
                  {book.passes
                    ? <Pill tone="up">book promotable</Pill>
                    : <Pill tone="accent">{book.nMembers === 0 ? "no sleeves admitted yet" : `${book.nMembers} sleeves · short of bar`}</Pill>}
                  <span className="num text-[10px] text-dim">
                    {book.nMembers === 0
                      ? "0 promoted · book deflated 0.00 / needs 1.00 — the gate is honest, nothing has cleared it"
                      : `${book.nMembers} admitted · last gated ${ago(book.updatedAt)} ago`}
                  </span>
                </div>
                {book.members.length > 0 && (
                  <div className="mt-3 well p-2.5 space-y-1">
                    {book.members.map((m, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className="truncate flex-1 text-mid">{m.name}</span>
                        <span className="num text-[10px] text-dim w-16 text-right">w {pct(m.weight, 0)}</span>
                        <span className="num text-[10px] text-dim w-20 text-right">rc {pct(m.riskContrib, 0)}</span>
                        <span className="num text-[10px] text-fg w-14 text-right">{fmt(m.standaloneSharpe)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* right: leader equity vs benchmarks */}
          <div className="min-w-0">
            <div className="flex items-center justify-between mb-2">
              <span className="hud">Leader equity vs S&amp;P 500 &amp; BTC buy-hold</span>
              {leader && <Link href={`/candidates/${leader._id}`} className="num text-[10px] text-dim hover:text-fg">{leader.name} →</Link>}
            </div>
            {headline ? (
              <>
                <Chart height={210} series={[
                  { name: headlineLabel, color: "#34d399", curve: headline },
                  ...(spx ? [{ name: "S&P 500", color: "#92a1b0", curve: spx, dash: true }] : []),
                  ...(btc ? [{ name: "BTC HODL", color: "#f4b740", curve: btc, dash: true }] : []),
                ]} />
                {stratMult !== undefined && (
                  <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                    <span className="num text-[10px] text-dim">$10k →
                      <span className="text-up"> ${(stratMult * 10000).toFixed(0)}</span>
                      {spxMult !== undefined && <span className="text-mid"> · S&P ${(spxMult * 10000).toFixed(0)}</span>}
                      {btcMult !== undefined && <span className="text-accent"> · BTC ${(btcMult * 10000).toFixed(0)}</span>}
                    </span>
                    {spxMult !== undefined && <Pill tone={stratMult > spxMult ? "up" : "down"}>{stratMult > spxMult ? "beats" : "trails"} S&P</Pill>}
                    {btcMult !== undefined && <Pill tone={stratMult > btcMult ? "up" : "down"}>{stratMult > btcMult ? "beats" : "trails"} BTC</Pill>}
                  </div>
                )}
              </>
            ) : <div className="well h-[210px] flex items-center justify-center"><span className="hud">no validated curve yet</span></div>}
          </div>
        </div>
      </Panel>

      {/* ============================== STAT TILES ============================== */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <Panel pad="p-3.5"><Stat label="Universe" value={data?.price.symbols ?? "·"} unit={`× ${data?.price.tfs.length ?? 0}tf`} /></Panel>
        <Panel pad="p-3.5"><Stat label="Sleeve families" value={families?.length ?? "·"} sub="DSL·XS·IV·OC" /></Panel>
        <Panel pad="p-3.5"><Stat label="Candidates" value={compact(flow?.total)} tone="fg" /></Panel>
        <Panel pad="p-3.5"><Stat label="In gauntlet" value={compact(flow?.inGauntlet)} tone="info" /></Panel>
        <Panel pad="p-3.5"><Stat label="Reached S5" value={compact(flow?.reachedS5)} tone="accent" sub="DSR stage" /></Panel>
        <Panel pad="p-3.5"><Stat label="Survivors" value={survivors} tone={survivors > 0 ? "up" : "dim"} sub="alive" /></Panel>
        <Panel pad="p-3.5"><Stat label="Champions" value={flow?.rows.find((r) => r.key === "champion")?.reached ?? 0} tone={(flow?.rows.find((r) => r.key === "champion")?.reached ?? 0) > 0 ? "promo" : "dim"} sub="honest 0" /></Panel>
      </div>

      {/* ============================== FUNNEL + ATTRIBUTION ============================== */}
      <div className="grid lg:grid-cols-[1.5fr_1fr] gap-4">
        <Panel title={<>Gauntlet funnel — where everything is &amp; where it dies</>} right={<span className="num text-[10px] text-dim">{flow?.total ?? 0} total · floors never bend</span>}>
          {flow && <Funnel rows={flow.rows} survivors={flow.survivors} />}
        </Panel>
        <Panel title="Lane attribution — best score by origin">
          {analytics && <Attribution stats={analytics.sourceStats} />}
        </Panel>
      </div>

      {/* ============================== LEADERBOARD + ACTIVITY ============================== */}
      <div className="grid lg:grid-cols-[1.4fr_1fr] gap-4">
        <Panel title="Leaderboard" right={<Link href="/tournament" className="num text-[10px] text-dim hover:text-fg">tournament →</Link>}>
          <div className="space-y-0.5">
            {(board ?? []).slice(0, 8).map((c, i) => {
              const m = c.metrics ? safeParse<Record<string, number>>(c.metrics) ?? {} : {};
              return (
                <Link key={c._id} href={`/candidates/${c._id}`} className="flex items-center gap-3 text-sm rounded px-2 py-1.5 hover:bg-[#ffffff05]">
                  <span className={`num w-5 text-center ${i === 0 ? "text-accent" : "text-dim"}`}>{i + 1}</span>
                  <span className="truncate flex-1 text-mid">{c.name}</span>
                  <span className="num text-[9px]" style={{ color: srcColor(c.source) }}>{c.source}</span>
                  <StageBadge stage={c.stage} />
                  <span className="num text-right w-12 text-accent">{fmt(c.composite)}</span>
                  <span className="num text-right w-12 text-dim">{fmt(m.portOosSharpe ?? m.wfPooledSharpe)}</span>
                </Link>
              );
            })}
            {!board?.length && <div className="hud py-6 text-center">empty board</div>}
          </div>
        </Panel>
        <Panel title="Live activity">
          <ActivityFeed items={activity.slice(0, 26)} />
        </Panel>
      </div>

      {/* ============================== SYSTEM STRIP ============================== */}
      <Panel pad="px-5 py-2.5">
        <div className="flex flex-wrap gap-x-7 gap-y-2 items-center">
          <span className="hud">system</span>
          <span className="num text-xs text-dim">trials <span className="text-fg">{trials ?? "·"}</span></span>
          <span className="num text-xs text-dim">LLM today <span className="text-fg">${((llm ?? 0) / 100).toFixed(2)}</span></span>
          <span className="num text-xs text-dim">data <span className={Date.now() - dataFresh < 2.5 * 3600_000 ? "text-up" : "text-down"}>{dataFresh ? ago(dataFresh) + " ago" : "·"}</span></span>
          <span className="num text-xs text-dim">universe <span className="text-fg">{data?.price.symbols ?? "·"}×{data?.price.tfs.length ?? "·"}tf</span></span>
          <Link href="/data" className="num text-xs text-dim hover:text-fg ml-auto">data &amp; system →</Link>
        </div>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------- helpers
function safeParse<T>(s: string): T | null { try { return JSON.parse(s) as T; } catch { return null; } }

// Rebase a {t,c} benchmark to growth-of-1 over the headline window. Skips
// non-positive/non-finite closes so one bad row can't NaN-poison the chart.
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
