"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Lead, Info, Panel, fmt, compact, ago } from "../components/ds";

// ================================================================ ENGINE
// "Is the discovery engine working, and what's it finding?" One plain-English
// status answer, three big numbers, what it's exploring, and how close anything is
// to being trusted with real money. Folds the old Pipeline + Sleeves + Data into
// one simple page — plain summaries, not dense tables.

// plain-English names for what the engine tries — both the curated strategy
// templates ("mechanisms") and the older generate/tweak recipes.
const MECH_PLAIN: Record<string, string> = {
  // curated mechanism templates
  trend_chop_gated: "Follow the trend, sit out the chop",
  breakout_vol_trail: "Buy breakouts on strong volume",
  meanrev_range: "Buy dips inside a range",
  tsmom_trend: "Ride medium-term momentum",
  vol_regime_size: "Trade more in calm markets",
  donchian_trend: "Classic channel breakout",
  carry_funding_tilt: "Lean on funding/carry",
  fresh_freeform: "Free exploration",
  // generation lanes / tweaks
  llm: "AI-proposed ideas",
  fresh: "Fresh random ideas",
  crossover: "Mixing two strategies",
  seed: "Starter strategies",
  imported: "Hand-built strategies",
  "gp-op:add_filter": "Adding a filter",
  "gp-op:remove_filter": "Removing a filter",
  "gp-op:chop_gate": "Adding a chop filter",
  "gp-op:op_swap": "Swapping a signal",
  "gp-op:param_shift": "Tuning the settings",
  "gp-op:new_exit": "Trying a new exit",
  "gp-op:profit_trail": "Adding a trailing stop",
  "gp-op:toggle_shorts": "Trying short trades",
  "gp-op:risk_overlay": "Adjusting risk/leverage",
  "gp-op:other": "Other tweaks",
};
function mechName(key: string): string {
  if (MECH_PLAIN[key]) return MECH_PLAIN[key];
  const base = key.replace(/^regime_switch:/, "");
  return (MECH_PLAIN[base] ?? base.replace(/_/g, " ")) + (key.startsWith("regime_switch:") ? " (regime-switched)" : "");
}

export default function EnginePage() {
  const flow = useQuery(api.dashboard.stageFlow, {});
  const runs = useQuery(api.pipeline.recentRuns, { limit: 60 });
  const ledger = useQuery(api.ledger.ledgerSnapshot, {});
  const book = useQuery(api.dashboard.bookStatus, {});
  const data = useQuery(api.dashboard.dataSources, {});

  const now = Date.now();
  const cycles = (runs ?? []).filter((r) => (r.kind === "ideate-opus" || r.kind === "evolve"));
  const cyclesToday = cycles.filter((r) => now - r.startedAt < 86400_000).length;
  const lastCycle = cycles[0]?.startedAt ?? 0;
  const running = lastCycle > 0 && now - lastCycle < 6 * 3600_000;
  const tested = flow?.total ?? 0;
  const survivors = flow?.survivors ?? 0;
  // rough strategies-per-day from the recent cycle cadence
  const perDay = cyclesToday > 0 ? cyclesToday * Math.round((tested) / Math.max(1, cycles.length)) : null;

  // top mechanisms by how much they've been tried (what it's exploring)
  const mechs = (ledger ?? []).filter((m) => m.attempts > 0).sort((a, b) => b.attempts - a.attempts).slice(0, 7);
  const maxAtt = Math.max(1, ...mechs.map((m) => m.attempts));

  // how close anything is to "trusted with real money"
  const progress = book?.progress ?? 0;
  const dataFresh = data?.price.lastTs ? Date.now() - data.price.lastTs < 2.5 * 3600_000 : false;

  return (
    <div className="space-y-7 stagger pb-12">
      {/* ============ the plain-English answer ============ */}
      <Lead dot={running ? "ok" : "warn"}>
        The engine is <span className={running ? "text-up" : "text-down"}>{running ? "running" : "idle"}</span>
        {perDay ? <>, testing about <span className="text-fg">{perDay} strategies a day</span></> : ""}, and learning which approaches hold up.{" "}
        <span className="text-dim text-[15px]">So far {compact(tested)} have been tested; {survivors} are good enough to trade live (with fake money).</span>
      </Lead>

      {/* ============ three big numbers ============ */}
      <section className="grid grid-cols-3 gap-px rounded-2xl overflow-hidden bg-[#ffffff08]">
        <Big label="Running?" value={running ? "Yes" : "No"} tone={running ? "up" : "down"} sub={lastCycle ? `last worked ${ago(lastCycle)} ago` : "—"} />
        <Big label="Strategies tested" value={compact(tested)} sub={`${cyclesToday} cycles today`} />
        <Big label="Good enough to trade" value={`${survivors}`} tone={survivors > 0 ? "accent" : "dim"} sub="passed the full test battery" />
      </section>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* ============ what it's exploring (plain) ============ */}
        <Panel pad="p-6" title={<span className="flex items-center">What it&apos;s exploring<Info>The engine builds strategies from a library of economically-grounded templates and keeps trying the ones that survive testing.</Info></span>}>
          {mechs.length ? (
            <div className="space-y-3">
              {mechs.map((m) => (
                <div key={m.mechanism}>
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="text-[13px] text-mid">{mechName(m.mechanism)}</span>
                    <span className="num text-[10px] text-dim">{m.attempts} tried{m.promotions > 0 ? <span className="text-up"> · {m.promotions} kept</span> : ""}</span>
                  </div>
                  <div className="h-[7px] bg-ink rounded-full overflow-hidden border border-edge/50">
                    <div className="h-full rounded-full" style={{ width: `${Math.max(4, (m.attempts / maxAtt) * 100)}%`, background: m.promotions > 0 ? "linear-gradient(90deg,#1f7a5f,#3ddb9e)" : "linear-gradient(90deg,#3a4654,#8b9aab)" }} />
                  </div>
                </div>
              ))}
            </div>
          ) : <div className="hud py-6 text-center">warming up — no mechanism stats yet</div>}
        </Panel>

        {/* ============ how close to real money + data health ============ */}
        <Panel pad="p-6" title={<span className="flex items-center">How close to real money<Info>To be trusted with real money a strategy must clear a strict confidence bar (deflated Sharpe ≥ 1.0) or a long live track record — plus human approval.</Info></span>}>
          <div className="flex items-end gap-3 mb-2">
            <div className="num text-[44px] leading-none text-accent">{(progress * 100).toFixed(0)}%</div>
            <div className="num text-[12px] text-dim mb-2">of the confidence bar</div>
          </div>
          <div className="relative h-3 rounded-full bg-[#ffffff0a] overflow-hidden mb-1">
            <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.min(100, progress * 100)}%`, background: progress >= 1 ? "linear-gradient(90deg,#1f7a5f,#3ddb9e)" : "linear-gradient(90deg,#7a5a12,#f5b932)" }} />
            <div className="absolute top-0 bottom-0 w-0.5 bg-up/80" style={{ left: "100%" }} />
          </div>
          <p className="num text-[11px] text-dim mt-3 leading-relaxed">
            Nothing has cleared the bar yet — that&apos;s honest. We test strategies freely with fake money but only promote to real money strictly, with human sign-off.
          </p>
          <div className="mt-5 pt-4 border-t border-edge/50 flex flex-wrap items-center gap-x-6 gap-y-2 num text-[11px]">
            <span className="text-dim">data feeds <span className="text-up">{(data?.orthogonal ?? []).filter((o) => o.live).length} live</span></span>
            <span className="text-dim">prices <span className={dataFresh ? "text-up" : "text-down"}>{data?.price.lastTs ? ago(data.price.lastTs) + " ago" : "—"}</span></span>
            <span className="text-dim">coverage <span className="text-fg">{data?.price.symbols ?? "·"} coins</span></span>
          </div>
        </Panel>
      </div>

      {/* ============ recent activity (tucked, small) ============ */}
      <Panel pad="p-6" title="Recent activity">
        <div className="space-y-0">
          {(runs ?? []).slice(0, 8).map((r) => (
            <div key={r._id} className="flex items-center gap-3 text-xs border-t border-edge/40 py-2 first:border-t-0 first:pt-0">
              <span className="num text-dim w-10 text-right shrink-0">{ago(r.startedAt)}</span>
              <span className="num text-[10px] w-24 text-mid shrink-0">{r.kind}</span>
              <span className={`num text-[10px] w-16 shrink-0 ${r.status === "error" ? "text-down" : r.status === "running" ? "text-info" : "text-dim"}`}>{r.status}</span>
              <span className="text-dim truncate flex-1 min-w-0">{(r.summary ?? "").slice(0, 80)}</span>
            </div>
          ))}
          {!runs?.length && <div className="hud py-4 text-center">no activity yet</div>}
        </div>
      </Panel>
    </div>
  );
}

function Big({ label, value, tone = "fg", sub }: { label: string; value: string; tone?: "fg" | "up" | "down" | "dim" | "accent"; sub?: string }) {
  const c = tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "dim" ? "text-dim" : tone === "accent" ? "text-accent" : "text-fg";
  return (
    <div className="bg-panel px-6 py-7">
      <div className="hud mb-3">{label}</div>
      <div className={`num text-[40px] leading-none ${c}`}>{value}</div>
      {sub && <div className="num text-[10px] text-dim mt-2.5">{sub}</div>}
    </div>
  );
}
