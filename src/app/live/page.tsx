"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Lead, Panel, Pill, Spark, Stat, fmt, ago, type Tone } from "../components/ds";

// ================================================================ LIVE TRADING
// Real-capital deployments: which validated strategies are wired to the exchange,
// in which mode (dry-run = full executor pipeline with simulated fills; live =
// real orders), their equity, current vs target weight, kill-switch levels and
// the full order audit trail. Read-only — deployments are created and flipped
// live from the CLI (scripts/live-deploy.ts), never from the browser.

interface Order {
  _id: string; ts: number; mode: string; side: string; qty: number; notionalUsd: number;
  price: number; fillPrice?: number; status: string; targetWeight: number; fromWeight: number; note?: string;
}
interface Dep {
  _id: string; name: string; symbol: string; mode: string; capitalUsd: number;
  maxWeight: number; rebalanceBand: number; maxDailyLossPct: number; maxDrawdownPct: number;
  cashUsd: number; baseQty: number; curWeight: number; equityUsd: number; peakEquityUsd: number;
  lastRunTs?: number; haltReason?: string; createdAt: number;
  orders: Order[]; spark: { t: number; eq: number }[];
}

const MODE_TONE: Record<string, Tone> = { live: "up", dryrun: "info", halted: "down", off: "dim" };
const MODE_LABEL: Record<string, string> = { live: "LIVE", dryrun: "DRY-RUN", halted: "HALTED", off: "OFF" };
const STATUS_TONE: Record<string, Tone> = { filled: "up", simulated: "info", rejected: "down", error: "down", skipped: "dim", sent: "accent" };

export default function LivePage() {
  const deps = useQuery(api.live.overview, {}) as Dep[] | undefined;

  if (deps === undefined) return <div className="hud py-20 text-center">loading…</div>;

  return (
    <div className="space-y-7 stagger pb-14">
      <Lead dot={deps.some((d) => d.mode === "live") ? "live" : "ok"}>
        <span className="text-fg">Real-capital deployments.</span>{" "}
        <span className="text-dim text-[15px]">
          Dry-run exercises the exact live pipeline with simulated fills; flipping to live only changes who fills the order.
          Deployments are managed from the CLI — nothing here can move money.
        </span>
      </Lead>

      {!deps.length && (
        <Panel title="no deployments yet">
          <div className="text-mid text-[14px] leading-relaxed">
            Wire a validated strategy to capital with{" "}
            <code className="text-accent">npx tsx scripts/live-deploy.ts --name &lt;sleeve&gt; --capital 1000</code>{" "}
            on the VPS. It starts in dry-run; the hourly executor picks it up, and this page fills in.
          </div>
        </Panel>
      )}

      {deps.map((d) => {
        const ret = d.capitalUsd > 0 ? d.equityUsd / d.capitalUsd - 1 : 0;
        const dd = d.peakEquityUsd > 0 ? d.equityUsd / d.peakEquityUsd - 1 : 0;
        const retTone: Tone = ret >= 0 ? "up" : "down";
        return (
          <section key={d._id} className={`panel p-6 ${d.mode === "live" ? "blue-glow-pulse" : ""}`}>
            <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-[17px] text-fg font-medium">{d.name}</span>
                <Pill tone={MODE_TONE[d.mode] ?? "dim"}>{MODE_LABEL[d.mode] ?? d.mode}</Pill>
                <Pill tone="dim" soft>{d.symbol}</Pill>
                {d.haltReason && <Pill tone="down" soft>{d.haltReason}</Pill>}
              </div>
              <div className="text-[12px] text-dim">
                {d.lastRunTs ? `executor ran ${ago(d.lastRunTs)}` : "waiting for first executor run"}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-5">
              <Stat label="equity" value={`$${fmt(d.equityUsd)}`} tone={retTone} sub={`of $${fmt(d.capitalUsd, 0)} allocated`} />
              <Stat label="return" value={`${ret >= 0 ? "+" : ""}${fmt(ret * 100)}%`} tone={retTone} />
              <Stat label="drawdown" value={`${fmt(dd * 100)}%`} tone={dd > -5 ? "fg" : dd > -12 ? "accent" : "down"} sub={`halt at -${d.maxDrawdownPct}%`} />
              <Stat label="weight" value={fmt(d.curWeight, 3)} sub={`cap ${fmt(d.maxWeight, 2)} · band ${fmt(d.rebalanceBand, 2)}`} />
              <Stat label="position" value={`${fmt(d.baseQty, 5)}`} unit={d.symbol.split("/")[0]} sub={`cash $${fmt(d.cashUsd)}`} />
              <div className="flex flex-col justify-center">
                {d.spark.length >= 2
                  ? <Spark values={d.spark.map((s) => s.eq)} width={150} height={36} tone={retTone} fill />
                  : <span className="text-[12px] text-dim">equity history builds as the executor runs</span>}
              </div>
            </div>

            <div className="tablewrap">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-dim text-left">
                    <th className="py-1.5 pr-3 font-normal">bar</th>
                    <th className="py-1.5 pr-3 font-normal">side</th>
                    <th className="py-1.5 pr-3 font-normal">notional</th>
                    <th className="py-1.5 pr-3 font-normal">fill</th>
                    <th className="py-1.5 pr-3 font-normal">weight</th>
                    <th className="py-1.5 pr-3 font-normal">status</th>
                    <th className="py-1.5 font-normal">note</th>
                  </tr>
                </thead>
                <tbody>
                  {!d.orders.length && (
                    <tr><td colSpan={7} className="py-3 text-dim">
                      no orders yet — {d.mode === "halted" ? "deployment halted" : "the executor trades at most once per strategy bar (daily for blends)"}
                    </td></tr>
                  )}
                  {d.orders.map((o) => (
                    <tr key={o._id} className="border-t border-[#ffffff0a]">
                      <td className="py-1.5 pr-3 text-mid whitespace-nowrap">{new Date(o.ts).toISOString().slice(0, 10)}</td>
                      <td className={`py-1.5 pr-3 ${o.side === "BUY" ? "text-up" : "text-down"}`}>{o.side}</td>
                      <td className="py-1.5 pr-3">${fmt(o.notionalUsd)}</td>
                      <td className="py-1.5 pr-3 text-mid">{o.fillPrice ? `$${fmt(o.fillPrice)}` : "—"}</td>
                      <td className="py-1.5 pr-3 text-mid">{fmt(o.fromWeight, 2)} → {fmt(o.targetWeight, 2)}</td>
                      <td className="py-1.5 pr-3"><Pill tone={STATUS_TONE[o.status] ?? "dim"} soft>{o.status}</Pill></td>
                      <td className="py-1.5 text-dim max-w-[260px] truncate">{o.note ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      <Panel title="how a strategy goes live" pad="p-5">
        <ol className="text-[13.5px] text-mid space-y-1.5 list-decimal list-inside">
          <li>Strategy survives the gauntlet and incubates in paper (30d floor, monitor grades it).</li>
          <li><code className="text-accent">live-deploy.ts --name &lt;sleeve&gt; --capital N</code> creates a <span className="text-info">dry-run</span> deployment — same signals, simulated fills, full audit trail here.</li>
          <li>After the dry-run tracks its paper sleeve, flip it: <code className="text-accent">live-deploy.ts --mode &lt;id&gt; live</code>. Needs the Binance key&apos;s Spot trading permission enabled.</li>
          <li>Kill switches flatten + halt on daily-loss / max-drawdown breaches. Every order lands in this table first.</li>
        </ol>
      </Panel>
    </div>
  );
}
