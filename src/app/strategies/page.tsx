"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import { ChartWithBenchmarks, Lead, Info, StageBadge, Spark, fmt, pct, type Curve } from "../components/ds";

// ================================================================ STRATEGIES
// "What are the best strategies, and do they beat just holding?" Daniel's SOLANA
// chop-gated SMA120 is the HERO (real measured numbers — its edge is dodging SOL's
// brutal crashes, NOT a bigger return). The proven BTC version is the secondary
// variant. Then a ranked list that puts PROVEN strategies first so an overfit
// reject is never shown as "#1". Backtest clearly labelled — live is on Live tab.

interface Row {
  id: string; name: string; stage: string; source: string;
  composite: number; oos: number; failedStage?: string;
  m: Record<string, number>; curve?: Curve; hodl?: Curve; alive: boolean; regime: boolean; solBench: boolean;
}
const ALIVE = new Set(["champion", "eligible", "incubating", "sealed_passed"]);

function parseRow(c: { _id: string; name: string; stage: string; source: string; composite?: number; failedStage?: string; metrics?: string; curves?: string }): Row {
  let m: Record<string, number> = {}, curve: Curve | undefined, hodl: Curve | undefined;
  try { m = c.metrics ? JSON.parse(c.metrics) : {}; } catch { /* */ }
  try {
    const cv = c.curves ? JSON.parse(c.curves) as { wf?: Curve; port?: Curve; full?: Curve; hodlFull?: Curve } : {};
    curve = cv.full ?? cv.port ?? cv.wf;
    hodl = cv.hodlFull;
  } catch { /* */ }
  return {
    id: c._id, name: c.name, stage: c.stage, source: c.source,
    composite: c.composite ?? 0, oos: m.portOosSharpe ?? m.wfPooledSharpe ?? 0,
    failedStage: c.failedStage, m, curve, hodl, alive: ALIVE.has(c.stage),
    regime: c.source === "regime" || m.userStrategy === 1, solBench: m.benchSymbol === 2,
  };
}
function totalOf(r: Row): number | undefined {
  const ct = r.curve?.eq?.length ? r.curve.eq[r.curve.eq.length - 1] / r.curve.eq[0] - 1 : undefined;
  return r.m.fullTotal ?? r.m.portTotal ?? ct;
}

export default function StrategiesPage() {
  const rowsRaw = useQuery(api.candidates.tournament, { limit: 80 });
  const mineRaw = useQuery(api.dashboard.userStrategies, {});
  const bench = useQuery(api.dashboard.benchmarks, {});
  const [selected, setSelected] = useState<string | null>(null);

  const tour = (rowsRaw ?? []).map(parseRow);
  const mine = (mineRaw ?? []).map(parseRow);
  // merge: user strategies (always present) + tournament, de-duped by id
  const byId = new Map<string, Row>();
  for (const r of [...mine, ...tour]) if (!byId.has(r.id)) byId.set(r.id, r);
  const rows = [...byId.values()];

  // HERO = Daniel's SOL strategy (benchSymbol SOL); fall back to any regime strat.
  const hero = mine.find((r) => r.regime && r.solBench) ?? mine.find((r) => r.regime) ?? rows.find((r) => r.regime) ?? null;
  const btcVariant = mine.find((r) => r.regime && !r.solBench && r.id !== hero?.id) ?? null;

  // RANKING FIX: proven (alive) first, then quality. An overfit reject can't outrank.
  const ranked = [...rows].sort((a, b) => (Number(b.alive) - Number(a.alive)) || (b.oos - a.oos) || (b.composite - a.composite));

  const sel = rows.find((r) => r.id === selected) ?? hero ?? ranked[0];
  const headline = sel?.curve;
  const t0 = headline?.t?.[0] ?? 0, t1 = headline?.t?.[headline.t.length - 1] ?? 0;
  const fmtD = (ts: number) => ts ? new Date(ts).toISOString().slice(0, 7) : "?";
  const windowYrs = t0 && t1 ? ((t1 - t0) / (365 * 86400_000)).toFixed(1) : "?";
  const windowLabel = t0 && t1 ? `${fmtD(t0)} to ${fmtD(t1)} (${windowYrs}y)` : "";

  // hero numbers (real measured)
  const hRet = hero ? totalOf(hero) : undefined;
  const hDD = hero?.m.fullMaxDD;
  const hHodlRet = hero?.m.hodlTotal;
  const hHodlDD = hero?.m.hodlMaxDD;
  const heldName = hero?.solBench ? "Solana" : "Bitcoin";
  const beatsRet = hRet != null && hHodlRet != null && hRet > hHodlRet;
  const ddImprove = hDD != null && hHodlDD != null && hHodlDD !== 0 ? (1 - Math.abs(hDD) / Math.abs(hHodlDD)) : null;
  // the chart's "just holding" line = the hero's own coin (SOL HODL for the SOL hero)
  const heroHodlRaw = hero?.hodl ? { t: hero.hodl.t, c: hero.hodl.eq } : null; // already growth-of-1; treat as price
  const heldLabel = `${hero?.solBench ? "SOL" : "BTC"} HODL`;
  const heldColor = hero?.solBench ? "#c191fb" : "#f5b932";

  return (
    <div className="space-y-7 stagger pb-12">
      {/* ============ plain-English answer (honest) ============ */}
      <Lead dot={ddImprove != null && ddImprove > 0.3 ? "ok" : "warn"}>
        {hero
          ? <>Your strategy {beatsRet
              ? <><span className="text-up">beat holding {heldName}</span></>
              : <>made <span className="text-up">{hRet != null ? `+${(hRet * 100).toFixed(0)}%` : "—"}</span> vs holding {heldName}&apos;s <span className="text-accent">{hHodlRet != null ? `+${(hHodlRet * 100).toFixed(0)}%` : "—"}</span></>}
              {ddImprove != null ? <> — its real edge is <span className="text-fg">~{(ddImprove * 100).toFixed(0)}% less risk</span> (it dodged {heldName}&apos;s brutal crash: a {hDD != null ? `${(hDD * 100).toFixed(0)}%` : "—"} dip vs {hHodlDD != null ? `${(hHodlDD * 100).toFixed(0)}%` : "—"})</> : ""}.{" "}
              <span className="text-dim text-[15px]">Historical backtest. The live test is on the Live tab.</span></>
          : <>These are the best strategies the engine has found, charted against just holding.</>}
      </Lead>

      {/* ============ HERO: Daniel's SOL strategy ============ */}
      {hero && (
        <section className="panel blue-glow-pulse p-7">
          <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
            <div>
              <div className="num text-[11px] blue-glow-text tracking-wider mb-1">★ YOUR STRATEGY — SOLANA</div>
              <div className="text-[22px] text-fg font-medium">SMA120 + chop filter on SOL</div>
              <div className="num text-[11px] text-dim mt-1">follow SOL&apos;s trend, sit out the chop, dodge the crashes</div>
            </div>
            <span className="num text-[10px] px-2.5 py-1 rounded text-accent shrink-0" style={{ background: "#f5b93212" }}>forward-testing · did not pass the strict test</span>
          </div>

          {/* the big numbers: backtest vs holding SOL */}
          <div className="grid sm:grid-cols-3 gap-5 mb-6">
            <div className="rounded-xl bg-[#3ddb9e0e] border border-[#3ddb9e22] p-4">
              <div className="hud mb-1.5">Backtest return</div>
              <div className="num text-[36px] leading-none text-up">{hRet != null ? `+${(hRet * 100).toFixed(0)}%` : "—"}</div>
              <div className="num text-[11px] text-dim mt-1.5">vs <span className="text-promo">{hHodlRet != null ? `+${(hHodlRet * 100).toFixed(0)}%` : "—"}</span> holding SOL</div>
            </div>
            <div className="rounded-xl bg-[#5cc8ff10] border border-[#5cc8ff33] p-4">
              <div className="hud mb-1.5 flex items-center">Worst dip — the edge<Info>Max drawdown — biggest drop from a peak. The chop filter sat out SOL&apos;s ~96% crash, so the strategy&apos;s worst dip is far smaller.</Info></div>
              <div className="num text-[36px] leading-none blue-glow-text">{hDD != null ? `${(hDD * 100).toFixed(0)}%` : "—"}</div>
              <div className="num text-[11px] text-dim mt-1.5">vs <span className="text-down">{hHodlDD != null ? `${(hHodlDD * 100).toFixed(0)}%` : "—"}</span> holding SOL{ddImprove != null ? ` · ~${(ddImprove * 100).toFixed(0)}% less risk` : ""}</div>
            </div>
            <div className="rounded-xl bg-[#ffffff05] border border-edge p-4">
              <div className="hud mb-1.5 flex items-center">Quality score<Info>Sharpe ratio — return per unit of risk. This SOL version scores below the BTC version and did not clear the strict bar.</Info></div>
              <div className="num text-[36px] leading-none text-fg">{fmt(hero.oos)}</div>
              <div className="num text-[11px] text-dim mt-1.5">Sharpe · weaker than the BTC version (below)</div>
            </div>
          </div>

          <div className="num text-[11px] text-accent mb-3">
            Historical backtest over ~{windowYrs}y. <span className="text-dim">Honest read: on raw return SOL buy-and-hold won this window — the strategy&apos;s value is cutting the drawdown (dodging the crash). It did NOT pass the strict proof test (the BTC version did).</span> The live test is on the <Link href="/" className="blue-glow-text hover:underline">Live tab</Link>.
          </div>

          {headline ? (
            <ChartWithBenchmarks
              height={300} yLabel="growth of $1" showMetrics
              storeKey="strategies-hero" benchmarks={bench}
              extra={heroHodlRaw ? [{ label: heldLabel, color: heldColor, raw: heroHodlRaw, primary: true }] : []}
              stratLabel="your strategy (SOL)"
              series={[{ name: "your strategy (SOL)", color: "#5cc8ff", curve: headline }]}
            />
          ) : <div className="well flex items-center justify-center" style={{ height: 300 }}><span className="hud">no curve</span></div>}
        </section>
      )}

      {/* ============ the PROVEN BTC variant (secondary) ============ */}
      {btcVariant && (
        <section className="panel p-5">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="num text-[10px] blue-glow-text tracking-wider mb-0.5">★ same idea on BITCOIN — the PROVEN one</div>
              <div className="num text-[12px] text-mid">Backtest <span className="text-up">+{totalOf(btcVariant) != null ? (totalOf(btcVariant)! * 100).toFixed(0) : "—"}%</span> vs holding BTC <span className="text-accent">+{btcVariant.m.hodlTotal != null ? (btcVariant.m.hodlTotal * 100).toFixed(0) : "—"}%</span> · worst dip <span className="blue-glow-text">{btcVariant.m.fullMaxDD != null ? (btcVariant.m.fullMaxDD * 100).toFixed(0) : "—"}%</span> vs BTC <span className="text-down">{btcVariant.m.hodlMaxDD != null ? (btcVariant.m.hodlMaxDD * 100).toFixed(0) : "—"}%</span> · Sharpe {fmt(btcVariant.oos)}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="num text-[10px] text-up">✓ passed the strict proof test</span>
              <button onClick={() => setSelected(btcVariant.id)} className="num text-[10px] px-2 py-1 rounded border border-edge text-dim hover:text-fg">chart it ↑</button>
            </div>
          </div>
        </section>
      )}

      {/* ============ ranked list — PROVEN first ============ */}
      <div>
        <div className="hud mb-1">All strategies <span className="text-dim normal-case">— proven ones first; click any to chart it above</span></div>
        <div className="num text-[10px] text-dim mb-3">A high &ldquo;quality&rdquo; score alone can be overfitting. A strategy is only <span className="text-up">proven</span> once it survives the full battery across many coins.</div>
        <div className="tablewrap">
          <table className="dt">
            <thead><tr>
              <th>#</th><th>strategy</th>
              <th>return<Info>Total backtest return over the test window.</Info></th>
              <th>worst dip<Info>Biggest drop from a peak (max drawdown). Smaller is safer.</Info></th>
              <th>quality<Info>Sharpe on unseen data. A high score that fails across coins is overfitting.</Info></th>
              <th>proven?<Info>Passed the full testing battery? Only proven strategies are trusted.</Info></th>
              <th>shape</th>
            </tr></thead>
            <tbody>
              {ranked.slice(0, 20).map((r, i) => {
                const ret = totalOf(r);
                const dd = r.m.fullMaxDD ?? r.m.portMaxDD ?? r.m.wfMaxDD;
                const isSel = r.id === sel?.id;
                return (
                  <tr key={r.id} onClick={() => setSelected(r.id)} style={{ cursor: "pointer" }}
                    className={`${r.regime ? "blue-glow" : ""} ${isSel ? "bg-[#5cc8ff0e]" : ""}`}>
                    <td style={{ textAlign: "left" }} className={`dt-num ${r.regime ? "blue-glow-text" : i === 0 ? "text-accent" : "text-dim"}`}>{r.regime ? "★" : i + 1}</td>
                    <td style={{ textAlign: "left" }}>
                      <Link href={`/candidates/${r.id}`} onClick={(e) => e.stopPropagation()} className={r.regime ? "blue-glow-text hover:underline" : "text-mid hover:text-up"}>{r.name}</Link>
                      {r.regime && <span className="num text-[8px] ml-2 px-1.5 py-0.5 rounded blue-glow-text" style={{ background: "#5cc8ff18" }}>★ yours</span>}
                    </td>
                    <td className={`dt-num ${(ret ?? 0) >= 0 ? "text-up" : "text-down"}`}>{ret !== undefined ? `${ret >= 0 ? "+" : ""}${(ret * 100).toFixed(0)}%` : "—"}</td>
                    <td className={`dt-num ${(dd ?? 0) < -0.25 ? "text-down" : "text-dim"}`}>{dd !== undefined ? pct(dd, 0) : "—"}</td>
                    <td className="dt-num text-mid">{fmt(r.oos)}</td>
                    <td>{r.alive ? <span className="num text-[10px] text-up">✓ proven</span> : r.failedStage ? <span className="num text-[10px] text-dim">overfit — failed testing</span> : <StageBadge stage={r.stage} />}</td>
                    <td><div className="flex justify-end">{r.curve ? <Spark values={r.curve.eq} width={64} height={18} /> : <span className="hud">—</span>}</div></td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={7} className="hud py-6" style={{ textAlign: "center" }}>no strategies scored yet</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="num text-[10px] text-dim mt-3 max-w-3xl">
          Some strategies show a high &ldquo;quality&rdquo; score but <span className="text-dim">failed testing</span> — they only worked on one coin and fell apart across the others (overfitting). Listed honestly, never ranked above a proven strategy. All returns are <span className="text-accent">historical backtests</span>, not live results. {windowLabel ? `Window: ${windowLabel}.` : ""}
        </p>
      </div>
    </div>
  );
}
