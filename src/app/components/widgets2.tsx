"use client";

// Precision-instrument widgets built on the design system (ds.tsx).

import { fmt, pct } from "./ds";

// ---------------------------------------------------------------- Funnel
// The headline pipeline visual: each ordered stage as a horizontal bar showing
// the surviving width (green) shrinking down the gauntlet, with the killed count
// at each stage (red) and the reached count on the right. Reads top-to-bottom as
// one funnel. Stages with 0 reached render as a thin ghost so the flow stays legible.
export interface FlowRow { key: string; label: string; reached: number; killed: number }

export function Funnel({ rows, survivors }: { rows: FlowRow[]; survivors: number }) {
  const max = Math.max(1, rows[0]?.reached ?? 1);
  const survivorKeys = new Set(["incubating", "book", "eligible", "champion"]);
  return (
    <div className="space-y-[5px]">
      {rows.map((r) => {
        const surv = Math.max(0, r.reached - r.killed);
        const wReach = (r.reached / max) * 100;
        const wKill = (r.killed / max) * 100;
        const isSurvivorStage = survivorKeys.has(r.key);
        const dead = r.reached === 0;
        return (
          <div key={r.key} className="flex items-center gap-2.5 group">
            <span className="num text-[10px] w-[148px] shrink-0 text-mid truncate">{r.label}</span>
            <div className="flex-1 h-[16px] relative rounded-[3px] overflow-hidden bg-ink border border-edge/60">
              {!dead && (
                <div className="absolute inset-y-0 left-0 flex">
                  <div className="h-full"
                    style={{ width: `${wReach - wKill}%`, background: isSurvivorStage ? "linear-gradient(90deg,#f4b74044,#f4b740bb)" : "linear-gradient(90deg,#1c6b54,#34d399cc)" }} />
                  {r.killed > 0 && <div className="h-full" style={{ width: `${wKill}%`, background: "linear-gradient(90deg,#5b1f1c,#f4604faa)" }} />}
                </div>
              )}
              <div className="absolute inset-0 flex items-center px-2 justify-end gap-2">
                {r.killed > 0 && <span className="num text-[9px] text-down/90">−{r.killed}</span>}
              </div>
            </div>
            <span className={`num text-[11px] w-12 text-right ${isSurvivorStage ? (surv > 0 ? "text-accent" : "text-dim") : surv > 0 ? "text-fg" : "text-dim"}`}>{surv > 0 ? surv : dead ? "·" : surv}</span>
          </div>
        );
      })}
      <div className="flex items-center gap-2.5 pt-1.5 mt-1 border-t border-edge/50">
        <span className="hud w-[148px] shrink-0 text-accent">Survivors (alive)</span>
        <div className="flex-1" />
        <span className={`num text-sm w-12 text-right ${survivors > 0 ? "text-accent" : "text-dim"}`}>{survivors}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Kill distribution
export function KillBars({ kills, max: maxRows = 8 }: { kills: Record<string, number>; max?: number }) {
  const rows = Object.entries(kills).sort((a, b) => b[1] - a[1]).slice(0, maxRows);
  const max = Math.max(1, ...rows.map(([, n]) => n));
  if (!rows.length) return <div className="hud py-4 text-center">no kills recorded</div>;
  return (
    <div className="space-y-1.5">
      {rows.map(([stage, n]) => (
        <div key={stage} className="flex items-center gap-2 text-xs">
          <span className="num text-[10px] w-[120px] shrink-0 text-mid truncate">{stage}</span>
          <div className="flex-1 h-[10px] bg-ink rounded-[3px] overflow-hidden border border-edge/50">
            <div className="h-full rounded-[3px]" style={{ width: `${(n / max) * 100}%`, background: "linear-gradient(90deg,#5b1f1c,#f4604fcc)" }} />
          </div>
          <span className="num w-8 text-right text-dim">{n}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Book progress
// The deflated-Sharpe progress-to-1.0 gauge — the binding promotion bar.
export function BookGauge({ deflated, target, raw }: { deflated: number; target: number; raw: number }) {
  const p = Math.max(0, Math.min(1, deflated / target));
  const passed = deflated >= target;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="hud">Deflated book Sharpe → promotable</span>
        <span className="num text-[11px]">
          <span className={passed ? "text-up" : "text-accent"}>{fmt(deflated)}</span>
          <span className="text-dim"> / {fmt(target)}</span>
        </span>
      </div>
      <div className="relative h-[10px] rounded-full bg-ink border border-edge overflow-hidden">
        <div className="h-full rounded-full transition-[width] duration-700"
          style={{ width: `${p * 100}%`, background: passed ? "linear-gradient(90deg,#1c6b54,#34d399)" : "linear-gradient(90deg,#7a5a12,#f4b740)" }} />
        {/* 1.0 target tick */}
        <div className="absolute top-0 bottom-0 w-px bg-up/70" style={{ left: "100%" }} />
      </div>
      <div className="flex justify-between num text-[9px] text-dim mt-1">
        <span>raw {fmt(raw)}</span>
        <span>{(p * 100).toFixed(0)}% of bar</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Source attribution
const SRC: Record<string, string> = {
  seed: "#5cc8ff", imported: "#c084fc", llm: "#f4b740", gp: "#92a1b0",
  mutation: "#34d399", crossover: "#5cc8ff", repair: "#f08a3c",
  xsection: "#c084fc", ivsleeve: "#5cc8ff", onchain: "#34d399",
};
export function srcColor(s: string): string { return SRC[s] ?? "#5e6c7a"; }

export function Attribution({ stats }: { stats: Record<string, { count: number; best: number; scored: number }> }) {
  const rows = Object.entries(stats).filter(([, s]) => s.best > -9).sort((a, b) => b[1].best - a[1].best);
  const max = Math.max(0.01, ...rows.map(([, s]) => s.best));
  if (!rows.length) return <div className="hud py-4 text-center">nothing scored yet</div>;
  return (
    <div className="space-y-2">
      {rows.map(([source, s]) => (
        <div key={source} className="text-xs">
          <div className="flex justify-between mb-1 items-baseline">
            <span className="num text-[11px]" style={{ color: srcColor(source) }}>{source}</span>
            <span className="num text-[10px] text-dim">{s.count} bred · best <span className="text-fg">{fmt(s.best)}</span></span>
          </div>
          <div className="h-[7px] bg-ink rounded-full overflow-hidden border border-edge/50">
            <div className="h-full rounded-full" style={{ width: `${Math.max(3, (s.best / max) * 100)}%`, background: `linear-gradient(90deg,${srcColor(source)}55,${srcColor(source)})` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Activity feed
export interface ActivityItem { ts: number; kind: string; text: string; tone: "up" | "down" | "dim" | "accent" }
export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  const ago = (ts: number) => { const s = (Date.now() - ts) / 1000; return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
  return (
    <div className="space-y-0 max-h-[420px] overflow-y-auto overflow-x-hidden -mr-1 pr-1">
      {items.map((it, i) => (
        <div key={i} className="flex gap-2.5 text-xs items-baseline border-t border-edge/40 py-[7px] min-w-0">
          <span className="num text-dim w-9 shrink-0 text-right">{ago(it.ts)}</span>
          <span className={`num text-[10px] w-14 shrink-0 ${it.tone === "up" ? "text-up" : it.tone === "down" ? "text-down" : it.tone === "accent" ? "text-accent" : "text-dim"}`}>{it.kind}</span>
          <span className="text-mid leading-snug truncate min-w-0">{it.text}</span>
        </div>
      ))}
      {!items.length && <div className="hud py-6 text-center">quiet</div>}
    </div>
  );
}
