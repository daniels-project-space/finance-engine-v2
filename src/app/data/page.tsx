"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "../../../convex/_generated/api";
import { Panel, Stat, Pill, fmt, ago, compact } from "../components/ds";

export default function DataPage() {
  const data = useQuery(api.dashboard.dataSources, {});
  const datasets = useQuery(api.pipeline.listDatasets, {});
  const trials = useQuery(api.pipeline.getCounter, { key: "trials_total" });
  const llm = useQuery(api.pipeline.getCounter, { key: `llm_usd_cents:${new Date().toISOString().slice(0, 10)}` });
  const runs = useQuery(api.pipeline.recentRuns, { limit: 10 });

  const fresh = data?.price.lastTs ?? 0;
  const freshOk = Date.now() - fresh < 2.5 * 3600_000;

  return (
    <div className="space-y-4 stagger">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Panel pad="p-3.5"><Stat label="Symbols" value={data?.price.symbols ?? "·"} unit={`× ${data?.price.tfs.length ?? 0}tf`} /></Panel>
        <Panel pad="p-3.5"><Stat label="Total bars" value={compact(data?.price.totalBars)} tone="fg" /></Panel>
        <Panel pad="p-3.5"><Stat label="Data gaps" value={data?.price.totalGaps ?? "·"} tone={(data?.price.totalGaps ?? 0) > 20 ? "down" : "dim"} /></Panel>
        <Panel pad="p-3.5"><Stat label="Price fresh" value={fresh ? ago(fresh) : "·"} unit="ago" tone={freshOk ? "up" : "down"} /></Panel>
        <Panel pad="p-3.5"><Stat label="Funding fresh" value={data?.funding.lastTs ? ago(data.funding.lastTs) : "·"} unit="ago" tone="dim" /></Panel>
      </div>

      <Panel title="Data sources — coverage & wiring">
        <div className="space-y-2">
          {(data?.orthogonal ?? []).map((s) => (
            <div key={s.key} className="flex items-center gap-3 py-1.5 border-t border-edge/40 first:border-t-0">
              <span className={`w-1.5 h-1.5 rounded-full ${s.live ? "bg-up" : "bg-faint"}`} />
              <span className="text-sm text-fg flex-1">{s.label}</span>
              <span className="num text-[10px] text-dim">{s.note}</span>
              <Pill tone={s.live ? "up" : "dim"}>{s.live ? "live" : "idle"}</Pill>
            </div>
          ))}
        </div>
        <div className="num text-[10px] text-dim mt-3">OKX perp tail migrated to ccxt (close + funding + contract-size-corrected volume, per-coin parity-exact). On-chain / DVOL / stablecoins refresh daily.</div>
      </Panel>

      <div className="grid lg:grid-cols-[1fr_1fr] gap-4">
        <Panel title="LLM lane & cost">
          <div className="flex items-end gap-6">
            <Stat label="Model" value="Opus" tone="promo" size="sm" sub="ideation lane" />
            <Stat label="Trials (DSR N)" value={trials ?? "·"} />
            <Stat label="Spend today" value={`$${((llm ?? 0) / 100).toFixed(2)}`} tone="fg" />
          </div>
          <div className="num text-[10px] text-dim mt-3">evolve :20/3h · ideate :50/3h · paper :12 · monitor 07:00 UTC</div>
        </Panel>
        <Panel title="Recent runs">
          <div className="space-y-0">
            {(runs ?? []).map((r) => (
              <div key={r._id} className="flex items-center gap-2.5 text-xs border-t border-edge/40 py-1.5 first:border-t-0">
                <span className="num text-dim w-9 text-right">{ago(r.startedAt)}</span>
                <span className="num text-[10px] w-20 text-mid">{r.kind}</span>
                <span className={`num text-[10px] ${r.status === "error" ? "text-down" : r.status === "running" ? "text-info" : "text-dim"}`}>{r.status}</span>
                <span className="text-dim truncate flex-1">{(r.summary ?? "").slice(0, 70)}</span>
              </div>
            ))}
            {!runs?.length && <div className="hud py-4 text-center">no runs</div>}
          </div>
        </Panel>
      </div>

      <Panel title="Price datasets" right={<Link href="/config" className="num text-[10px] text-dim hover:text-fg">config →</Link>}>
        <div className="tablewrap max-h-[420px] overflow-y-auto">
          <table className="dt">
            <thead><tr><th>symbol</th><th>tf</th><th>bars</th><th>gaps</th><th>last bar (UTC)</th></tr></thead>
            <tbody>
              {(datasets ?? []).map((d) => (
                <tr key={d._id}>
                  <td style={{ textAlign: "left" }} className="text-mid">{d.symbol}</td>
                  <td className="dt-num text-dim">{d.tf}</td>
                  <td className="dt-num text-fg">{d.bars.toLocaleString()}</td>
                  <td className={`dt-num ${d.gaps > 5 ? "text-down" : "text-dim"}`}>{d.gaps}</td>
                  <td className="dt-num text-dim text-xs">{new Date(d.lastTs).toISOString().slice(0, 16)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!datasets?.length && <div className="hud py-4 text-center">no datasets</div>}
      </Panel>
    </div>
  );
}
