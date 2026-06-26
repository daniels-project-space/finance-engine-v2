"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "../../../convex/_generated/api";
import { Panel, Stat, Pill, fmt, ago, compact } from "../components/ds";

export default function DataPage() {
  const data = useQuery(api.dashboard.dataSources, {});
  const datasets = useQuery(api.pipeline.listDatasets, {});

  const fresh = data?.price.lastTs ?? 0;
  const freshOk = Date.now() - fresh < 2.5 * 3600_000;

  // DATA — lean: three headline counts, the feed wiring, and the datasets table.
  // The LLM-cost and recent-runs detail panels were removed (they live on the
  // Overview pulse / Config).
  return (
    <div className="space-y-5 stagger">
      <div className="grid grid-cols-3 gap-3">
        <Panel pad="p-4"><Stat label="Symbols" value={data?.price.symbols ?? "·"} unit={`× ${data?.price.tfs.length ?? 0}tf`} /></Panel>
        <Panel pad="p-4"><Stat label="Total bars" value={compact(data?.price.totalBars)} tone="fg" /></Panel>
        <Panel pad="p-4"><Stat label="Price fresh" value={fresh ? ago(fresh) : "·"} unit="ago" tone={freshOk ? "up" : "down"} /></Panel>
      </div>

      <Panel title="Data sources — coverage & wiring" pad="p-6">
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

      <Panel title="Price datasets" pad="p-6" right={<Link href="/config" className="num text-[10px] text-dim hover:text-fg">config →</Link>}>
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
