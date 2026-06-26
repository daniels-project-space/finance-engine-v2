"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "../../../convex/_generated/api";
import { Panel, Stat, StageBadge, Spark, fmt, ago, compact, type Curve } from "../components/ds";
import { srcColor, familyOf, GauntletTrail } from "../components/widgets2";

const STAGES = ["queued", "gauntlet", "failed", "incubating", "eligible", "champion", "sealed_passed", "archived", "demoted"];

function CandidatesInner() {
  const params = useSearchParams();
  const [stage, setStage] = useState(params.get("stage") ?? "");
  const byStage = useQuery(api.candidates.listByStage, stage ? { stage, limit: 120 } : "skip");
  const recent = useQuery(api.candidates.recent, !stage ? { limit: 120 } : "skip");
  const board = useQuery(api.candidates.tournament, { limit: 6 });
  const flow = useQuery(api.dashboard.stageFlow, {});
  const rows = stage ? byStage : recent;

  return (
    <div className="space-y-4 stagger">
      {/* tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Panel pad="p-4"><Stat label="Total bred" value={compact(flow?.total)} /></Panel>
        <Panel pad="p-4"><Stat label="In gauntlet" value={compact(flow?.inGauntlet)} tone="info" /></Panel>
        <Panel pad="p-4"><Stat label="Survivors" value={flow?.survivors ?? 0} tone={(flow?.survivors ?? 0) > 0 ? "up" : "dim"} /></Panel>
        <Panel pad="p-4"><Stat label="Best composite" value={fmt(board?.[0]?.composite)} tone="accent" /></Panel>
      </div>

      {/* top by composite (works even when nobody is 'alive') */}
      <Panel title="Top by composite" right={<Link href="/strategies" className="num text-[10px] text-dim hover:text-fg">strategies →</Link>}>
        <div className="grid md:grid-cols-2 gap-x-6 gap-y-1">
          {(board ?? []).map((c, i) => {
            const m: Record<string, number> = safeParse(c.metrics) ?? {};
            const cv: { wf?: Curve; port?: Curve } = safeParse(c.curves) ?? {};
            return (
              <Link key={c._id} href={`/candidates/${c._id}`} className="flex items-center gap-3 text-sm rounded-lg px-2.5 py-2 hover:bg-[#ffffff06]">
                <span className={`num w-4 ${i === 0 ? "text-accent" : "text-dim"}`}>{i + 1}</span>
                <span className="truncate flex-1 text-mid">{c.name}</span>
                <Spark values={(cv.port ?? cv.wf)?.eq ?? []} width={70} height={20} />
                <span className="num text-[9px]" style={{ color: srcColor(c.source) }}>{c.source}</span>
                <span className="num w-12 text-right text-accent">{fmt(c.composite)}</span>
                <span className="num w-12 text-right text-dim">{fmt(m.portOosSharpe ?? m.wfPooledSharpe)}</span>
              </Link>
            );
          })}
          {!board?.length && <div className="hud py-4 text-center">nothing scored yet</div>}
        </div>
      </Panel>

      {/* full list */}
      <Panel title="All candidates" right={
        <select value={stage} onChange={(e) => setStage(e.target.value)}
          className="num text-[11px] bg-[#ffffff08] border border-[#ffffff0f] rounded-md px-2 py-1 text-mid outline-none">
          <option value="">recent (all)</option>
          {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      }>
        <div className="tablewrap">
          <table className="dt">
            <thead><tr><th>name</th><th>family</th><th>trail</th><th>stage</th><th>composite</th><th>failed at</th><th>age</th></tr></thead>
            <tbody>
              {(rows ?? []).map((c) => (
                <tr key={c._id}>
                  <td style={{ textAlign: "left" }}>
                    <Link href={`/candidates/${c._id}`} className="text-mid hover:text-up">{c.name}</Link>
                    <span className="num text-[9px] ml-2" style={{ color: srcColor(c.source) }}>{c.source}</span>
                  </td>
                  <td style={{ textAlign: "left" }} className="num text-[10px] text-dim">{familyOf(c.source)}</td>
                  <td><div className="flex justify-end"><GauntletTrail failedStage={c.failedStage} stage={c.stage} /></div></td>
                  <td><StageBadge stage={c.stage} /></td>
                  <td className="dt-num text-accent">{fmt(c.composite)}</td>
                  <td style={{ textAlign: "left" }} className="text-dim text-[11px] truncate max-w-[240px]">{c.failedStage ? `${c.failedStage}` : "—"}</td>
                  <td className="dt-num text-dim text-xs">{ago(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows?.length && <div className="hud py-6 text-center">empty</div>}
      </Panel>
    </div>
  );
}

function safeParse<T>(s: string | undefined | null): T | null { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } }

export default function CandidatesPage() {
  return <Suspense fallback={<div className="hud py-10 text-center">loading…</div>}><CandidatesInner /></Suspense>;
}
