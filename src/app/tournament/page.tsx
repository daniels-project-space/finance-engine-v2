"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "../../../convex/_generated/api";
import { Panel, Stat, StageBadge, Spark, fmt, pct, type Curve } from "../components/ds";
import { srcColor } from "../components/widgets2";

interface Parsed {
  id: string; name: string; stage: string; source: string; composite: number;
  failedStage?: string; tf: string; m: Record<string, number>; wf?: Curve;
}
function parseRow(c: { _id: string; name: string; stage: string; source: string; composite?: number; failedStage?: string; metrics?: string; curves?: string; dsl?: string }): Parsed {
  let m: Record<string, number> = {}, wf: Curve | undefined, tf = "";
  try { m = c.metrics ? JSON.parse(c.metrics) : {}; } catch { /* */ }
  try { const cv = c.curves ? JSON.parse(c.curves) as { wf?: Curve; port?: Curve } : {}; wf = cv.port ?? cv.wf; } catch { /* */ }
  try { tf = c.dsl ? (JSON.parse(c.dsl).tf ?? "") : ""; } catch { /* */ }
  return { id: c._id, name: c.name, stage: c.stage, source: c.source, composite: c.composite ?? 0, failedStage: c.failedStage, tf, m, wf };
}

const ALIVE = new Set(["champion", "eligible", "incubating", "sealed_passed"]);

// compact gauntlet trail: which stage each candidate reached / died at.
const TRAIL = ["S2", "S3", "S4", "S5", "S5b", "S5c", "S6"];
function Trail({ failedStage, stage }: { failedStage?: string; stage: string }) {
  const alive = ALIVE.has(stage);
  let dead = -1;
  if (failedStage) {
    const norm = failedStage.replace(/^S(\d+\w*)-.*/, "S$1").replace(/[a-z]?(walkforward|stats|portfolio|cross|train|stress|sealed|pbo)/, "");
    const base = failedStage.startsWith("S5b") ? "S5b" : failedStage.startsWith("S5c") ? "S5c" : failedStage.split("-")[0].replace(/[a-z]+$/, "");
    dead = TRAIL.indexOf(base);
  }
  return (
    <div className="flex items-center gap-[3px]">
      {TRAIL.map((s, i) => {
        const state = alive ? "pass" : dead === -1 ? "pending" : i < dead ? "pass" : i === dead ? "dead" : "unreached";
        const bg = state === "pass" ? "#1c6b54" : state === "dead" ? "#f4604f" : state === "pending" ? "#3a4651" : "#1e2730";
        return <div key={s} className="w-4 h-[5px] rounded-sm" style={{ background: bg, boxShadow: state === "dead" ? "0 0 5px #f4604faa" : undefined }} title={`${s} ${state}`} />;
      })}
    </div>
  );
}

function Table({ rows }: { rows: Parsed[] }) {
  return (
    <div className="tablewrap">
      <table className="dt">
        <thead><tr>
          <th>#</th><th>strategy</th><th>trail</th><th>wf equity</th>
          <th>score</th><th>port shrp</th><th>wf shrp</th><th>sealed</th><th>max dd</th><th>win%</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id}>
              <td style={{ textAlign: "left" }} className="dt-num text-dim">{i + 1}</td>
              <td style={{ textAlign: "left" }}>
                <Link href={`/candidates/${r.id}`} className="text-mid hover:text-up">{r.name}</Link>
                <div className="num text-[9px] text-dim">
                  <span style={{ color: srcColor(r.source) }}>{r.source}</span>{r.tf ? ` · ${r.tf}` : ""}{r.failedStage ? ` · ✗ ${r.failedStage}` : ` · ${r.stage}`}
                </div>
              </td>
              <td><div className="flex justify-end"><Trail failedStage={r.failedStage} stage={r.stage} /></div></td>
              <td><div className="flex justify-end">{r.wf ? <Spark values={r.wf.eq} width={84} height={22} /> : <span className="hud">—</span>}</div></td>
              <td className="dt-num text-accent">{fmt(r.composite)}</td>
              <td className="dt-num text-up">{fmt(r.m.portOosSharpe)}</td>
              <td className="dt-num text-fg">{fmt(r.m.wfPooledSharpe)}</td>
              <td className="dt-num text-dim">{fmt(r.m.sealedSharpe)}</td>
              <td className={`dt-num ${(r.m.fullMaxDD ?? 0) < -0.25 ? "text-down" : "text-dim"}`}>{pct(r.m.fullMaxDD, 0)}</td>
              <td className="dt-num text-dim">{pct(r.m.winRate, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TournamentPage() {
  const rows = useQuery(api.candidates.tournament, { limit: 80 });
  const parsed = rows?.map(parseRow) ?? [];
  const league = parsed.filter((r) => ALIVE.has(r.stage));
  const fallen = parsed.filter((r) => !ALIVE.has(r.stage));

  return (
    <div className="space-y-4 stagger">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Panel pad="p-3.5"><Stat label="Scored" value={parsed.length} /></Panel>
        <Panel pad="p-3.5"><Stat label="Alive (league)" value={league.length} tone={league.length > 0 ? "up" : "dim"} /></Panel>
        <Panel pad="p-3.5"><Stat label="Best composite" value={fmt(parsed[0]?.composite)} tone="accent" /></Panel>
        <Panel pad="p-3.5"><Stat label="Best OOS Sharpe" value={fmt(Math.max(0, ...parsed.map((p) => p.m.portOosSharpe ?? p.m.wfPooledSharpe ?? 0)))} tone="up" /></Panel>
      </div>

      <Panel title="League — alive (gauntlet + sealed holdout passed)">
        {league.length ? <Table rows={league} /> : <div className="hud py-5 text-center">nobody alive yet — the seat is earned, not seeded</div>}
      </Panel>

      <Panel title="Qualifiers — best of the field (ranked by composite at death)" right={<span className="num text-[10px] text-dim">composite = 0.5·wf + 0.3·sealed + 0.2·full</span>}>
        {fallen.length ? <Table rows={fallen.slice(0, 50)} /> : <div className="hud py-5 text-center">no scored candidates yet</div>}
      </Panel>
    </div>
  );
}
