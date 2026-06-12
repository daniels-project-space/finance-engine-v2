"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "../../../convex/_generated/api";
import { StageBadge, fmtNum, timeAgo } from "../components/ui";

function CandidatesInner() {
  const params = useSearchParams();
  const [stage, setStage] = useState(params.get("stage") ?? "");
  const byStage = useQuery(api.candidates.listByStage, stage ? { stage, limit: 100 } : "skip");
  const recent = useQuery(api.candidates.recent, !stage ? { limit: 100 } : "skip");
  const leaders = useQuery(api.candidates.leaderboard, { limit: 10 });
  const rows = stage ? byStage : recent;

  return (
    <div className="space-y-6">
      <section className="panel p-5">
        <div className="hud mb-3">Leaderboard (composite = 0.5·WF + 0.3·sealed + 0.2·full)</div>
        <div className="grid md:grid-cols-2 gap-2">
          {leaders?.map((c, i) => (
            <Link key={c._id} href={`/candidates/${c._id}`} className="flex items-center gap-3 text-sm hover:bg-edge/40 rounded px-2 py-1">
              <span className="num text-dim w-5">{i + 1}</span>
              <span className="num text-gold w-14">{fmtNum(c.composite)}</span>
              <StageBadge stage={c.stage} />
              <span className="truncate">{c.name}</span>
            </Link>
          ))}
          {!leaders?.length && <div className="text-dim text-sm">Nothing has scored yet.</div>}
        </div>
      </section>

      <section className="panel p-5">
        <div className="flex items-center gap-4 mb-4">
          <div className="hud">Candidates</div>
          <select value={stage} onChange={(e) => setStage(e.target.value)} className="bg-ink border border-edge rounded px-2 py-1 text-sm">
            <option value="">recent (all)</option>
            {["queued", "gauntlet", "failed", "incubating", "eligible", "champion", "archived", "demoted"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <table className="w-full text-sm">
          <thead><tr className="hud text-left"><th className="pb-2">name</th><th>stage</th><th>source</th><th>failed at</th><th className="text-right">composite</th><th className="text-right">age</th></tr></thead>
          <tbody>
            {rows?.map((c) => (
              <tr key={c._id} className="border-t border-edge/60 hover:bg-edge/30">
                <td className="py-2"><Link href={`/candidates/${c._id}`} className="hover:text-up">{c.name}</Link></td>
                <td><StageBadge stage={c.stage} /></td>
                <td className="text-dim num text-xs">{c.source}</td>
                <td className="text-dim text-xs truncate max-w-[280px]">{c.failedStage ? `${c.failedStage}: ${c.failedReason}` : ""}</td>
                <td className="num text-right">{fmtNum(c.composite)}</td>
                <td className="num text-dim text-right text-xs">{timeAgo(c.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows?.length && <div className="text-dim text-sm py-4">Empty.</div>}
      </section>
    </div>
  );
}

export default function CandidatesPage() {
  return <Suspense fallback={<div className="hud">loading…</div>}><CandidatesInner /></Suspense>;
}
