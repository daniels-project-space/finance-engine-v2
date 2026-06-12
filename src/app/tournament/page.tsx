"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "../../../convex/_generated/api";
import { GauntletTrail, LineChart, MiniCurve, type Curve } from "../components/charts";
import { SOURCE_COLORS } from "../components/widgets";
import { StageBadge, fmtNum, fmtPct } from "../components/ui";

interface Parsed {
  id: string; name: string; stage: string; source: string; composite: number;
  failedStage?: string; tf: string; lev: string;
  m: Record<string, number>;
  wfCurve?: Curve;
}

function parseRow(c: { _id: string; name: string; stage: string; source: string; composite?: number; failedStage?: string; metrics?: string; curves?: string; dsl?: string }): Parsed {
  let m: Record<string, number> = {};
  let wfCurve: Curve | undefined;
  let tf = "1h", lev = "";
  try { m = c.metrics ? JSON.parse(c.metrics) : {}; } catch {}
  try { wfCurve = c.curves ? (JSON.parse(c.curves) as { wf?: Curve }).wf : undefined; } catch {}
  try {
    const d = c.dsl ? JSON.parse(c.dsl) as { tf?: string; risk?: { volTargetAnnual?: number; maxLeverage?: number } } : {};
    tf = d.tf ?? "1h";
    if (d.risk?.volTargetAnnual) lev = `σ${(d.risk.volTargetAnnual * 100).toFixed(0)}·L${d.risk.maxLeverage ?? 2}`;
  } catch {}
  return { id: c._id, name: c.name, stage: c.stage, source: c.source, composite: c.composite ?? 0, failedStage: c.failedStage, tf, lev, m, wfCurve };
}

const ACTIVE_STAGES = new Set(["champion", "eligible", "incubating", "sealed_passed"]);

function Row({ r, rank }: { r: Parsed; rank: number }) {
  return (
    <tr className="border-t border-edge/60 hover:bg-edge/30">
      <td className="num text-dim py-2 pr-2">{rank}</td>
      <td className="pr-3">
        <Link href={`/candidates/${r.id}`} className="hover:text-up">{r.name}</Link>
        <div className="num text-[10px] text-dim">{r.source} · {r.tf}{r.lev ? ` · ${r.lev}` : ""}{r.failedStage ? ` · out at ${r.failedStage}` : ""}</div>
      </td>
      <td><GauntletTrail failedStage={r.failedStage} stage={r.stage} /></td>
      <td className="px-2"><MiniCurve curve={r.wfCurve} /></td>
      <td className="num text-right text-gold">{fmtNum(r.composite)}</td>
      <td className="num text-right text-up">{fmtNum(r.m.portOosSharpe)}</td>
      <td className="num text-right">{fmtNum(r.m.wfPooledSharpe)}</td>
      <td className="num text-right">{fmtNum(r.m.sealedSharpe)}</td>
      <td className="num text-right">{fmtNum(r.m.fullSharpe)}</td>
      <td className={`num text-right ${(r.m.fullMaxDD ?? 0) < -0.25 ? "text-down" : "text-dim"}`}>{fmtPct(r.m.fullMaxDD, 0)}</td>
      <td className="num text-right text-dim">{fmtPct(r.m.winRate, 0)}</td>
      <td className="num text-right text-dim">{r.m.fullTrades ?? "—"}</td>
      <td className="num text-right text-dim">{fmtNum(r.m.dsr, 2)}</td>
    </tr>
  );
}

export default function TournamentPage() {
  const rows = useQuery(api.candidates.tournament, { limit: 80 });
  const funnel = useQuery(api.candidates.funnel, {});
  const parsed = rows?.map(parseRow) ?? [];
  const league = parsed.filter((r) => ACTIVE_STAGES.has(r.stage));
  const qualifiers = parsed.filter((r) => !ACTIVE_STAGES.has(r.stage));

  return (
    <div className="space-y-6">
      <section className="panel p-5">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-xl font-semibold">Tournament</h1>
            <p className="text-dim text-sm mt-1">
              Every strategy fights the same gauntlet. Composite = 0.5·walk-forward OOS Sharpe + 0.3·sealed Sharpe + 0.2·full Sharpe.
              Champion seat requires surviving 30 days of live paper inside its own confidence bands, then beating the incumbent by 10%.
            </p>
          </div>
          <div className="num text-xs text-dim">
            {funnel ? `${(funnel.failed ?? 0) + (funnel.graveyard ?? 0)} killed · ${funnel.incubating ?? 0} incubating · ${funnel.eligible ?? 0} eligible · ${funnel.champion ?? 0} champion` : "…"}
          </div>
        </div>
      </section>

      {/* ============ podium ============ */}
      {parsed.length >= 3 && (
        <section className="grid md:grid-cols-3 gap-4">
          {[parsed[1], parsed[0], parsed[2]].map((r, slot) => {
            const rank = slot === 1 ? 1 : slot === 0 ? 2 : 3;
            const medal = rank === 1 ? "#e8b34b" : rank === 2 ? "#9fb0bd" : "#b0793f";
            return (
              <Link key={r.id} href={`/candidates/${r.id}`}
                className={`panel p-4 relative overflow-hidden hover:border-dim transition-colors ${rank === 1 ? "md:-translate-y-2" : ""}`}>
                <div className="absolute inset-0 pointer-events-none" style={{ background: `radial-gradient(420px 140px at 50% -30%, ${medal}1f, transparent)` }} />
                <div className="relative">
                  <div className="flex items-center justify-between mb-1">
                    <span className="num text-2xl font-bold" style={{ color: medal }}>#{rank}</span>
                    <span className="num text-[10px] px-1.5 py-0.5 rounded border border-edge" style={{ color: SOURCE_COLORS[r.source] }}>{r.source} · {r.tf}</span>
                  </div>
                  <div className="font-semibold truncate">{r.name}</div>
                  <div className="num text-[10px] text-dim mb-2">{r.failedStage ? `out at ${r.failedStage}` : r.stage}</div>
                  {r.wfCurve ? <LineChart series={[{ name: "WF OOS", color: medal, curve: r.wfCurve }]} height={110} yLabel="" /> : <div className="hud py-8 text-center">no curve</div>}
                  <div className="flex justify-between mt-2 num text-xs">
                    <span className="text-gold">comp {fmtNum(r.composite)}</span>
                    <span className="text-dim">wf {fmtNum(r.m.wfPooledSharpe)}</span>
                    <span className="text-dim">dd {fmtPct(r.m.fullMaxDD, 0)}</span>
                    <span className="text-dim">win {fmtPct(r.m.winRate, 0)}</span>
                  </div>
                </div>
              </Link>
            );
          })}
        </section>
      )}

      <section className="panel p-5">
        <div className="hud mb-3">League — alive (gauntlet + sealed holdout passed)</div>
        {league.length ? (
          <div className="tablewrap"><table className="w-full text-sm">
            <thead><tr className="hud text-left">
              <th className="pb-2">#</th><th>strategy</th><th>gauntlet trail</th><th className="px-2">WF OOS equity</th>
              <th className="text-right">comp</th><th className="text-right">PORT</th><th className="text-right">BTC wf</th><th className="text-right">sealed</th>
              <th className="text-right">full</th><th className="text-right">maxDD</th><th className="text-right">win%</th>
              <th className="text-right">trades</th><th className="text-right">DSR</th>
            </tr></thead>
            <tbody>{league.map((r, i) => <Row key={r.id} r={r} rank={i + 1} />)}</tbody>
          </table></div>
        ) : (
          <div className="text-dim text-sm py-3">
            Nobody alive yet. The league seat is earned, not seeded — candidates below show how close the field is getting.
          </div>
        )}
      </section>

      <section className="panel p-5">
        <div className="hud mb-3">Qualifiers — best of the fallen (ranked by partial composite at time of death)</div>
        {qualifiers.length ? (
          <div className="tablewrap"><table className="w-full text-sm">
            <thead><tr className="hud text-left">
              <th className="pb-2">#</th><th>strategy</th><th>gauntlet trail</th><th className="px-2">WF OOS equity</th>
              <th className="text-right">comp</th><th className="text-right">PORT</th><th className="text-right">BTC wf</th><th className="text-right">sealed</th>
              <th className="text-right">full</th><th className="text-right">maxDD</th><th className="text-right">win%</th>
              <th className="text-right">trades</th><th className="text-right">DSR</th>
            </tr></thead>
            <tbody>{qualifiers.slice(0, 40).map((r, i) => <Row key={r.id} r={r} rank={i + 1} />)}</tbody>
          </table></div>
        ) : <div className="text-dim text-sm py-3">No scored candidates yet — run a cycle.</div>}
      </section>
    </div>
  );
}
