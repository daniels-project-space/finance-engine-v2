"use client";

// Dashboard widgets: progression chart, funnel, attribution bars, activity feed.
// Dependency-free SVG with gradients + glow.

import Link from "next/link";
import { fmtNum, timeAgo } from "./ui";

export const SOURCE_COLORS: Record<string, string> = {
  seed: "#5aa9e6",
  imported: "#b07ce8",
  llm: "#e8b34b",
  gp: "#6b7a87",
  mutation: "#2dd4a7",
  crossover: "#4fd1ea",
  repair: "#f4a04f",
};

// ---------------------------------------------------------------- progression
export interface ProgressionPoint { t: number; c: number; source: string; name: string }

export function ProgressionChart({ points, target, height = 240 }: { points: ProgressionPoint[]; target?: number; height?: number }) {
  if (!points.length) return <div className="hud py-8 text-center">no scored candidates yet</div>;
  const width = 980, padL = 44, padR = 14, padT = 16, padB = 26;
  const t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
  // cumulative best (the record line)
  const record: { t: number; c: number; name: string }[] = [];
  let best = -Infinity;
  for (const p of points) if (p.c > best) { best = p.c; record.push({ t: p.t, c: p.c, name: p.name }); }
  const yLo = Math.min(0, ...points.map((p) => p.c));
  const yHi = Math.max(target ?? 0, best) * 1.12 || 1;
  const X = (t: number) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (width - padL - padR);
  const Y = (c: number) => padT + (1 - (c - yLo) / (yHi - yLo)) * (height - padT - padB);

  // step path for the record line
  let d = `M ${X(record[0].t)} ${Y(record[0].c)}`;
  for (let i = 1; i < record.length; i++) d += ` L ${X(record[i].t)} ${Y(record[i - 1].c)} L ${X(record[i].t)} ${Y(record[i].c)}`;
  d += ` L ${X(t1)} ${Y(record[record.length - 1].c)}`;
  const area = `${d} L ${X(t1)} ${Y(yLo)} L ${X(record[0].t)} ${Y(yLo)} Z`;

  const fmtT = (t: number) => {
    const dte = new Date(t);
    return `${String(dte.getUTCHours()).padStart(2, "0")}:${String(dte.getUTCMinutes()).padStart(2, "0")}`;
  };
  const sameDay = t1 - t0 < 86_400_000 * 1.5;
  const fmtTick = (t: number) => sameDay ? fmtT(t) : new Date(t).toISOString().slice(5, 10);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: height }}>
      <defs>
        <linearGradient id="recArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e8b34b" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#e8b34b" stopOpacity="0.02" />
        </linearGradient>
        <filter id="glow"><feGaussianBlur stdDeviation="2.2" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      {[0.25, 0.5, 0.75, 1].map((f) => {
        const v = yLo + (yHi - yLo) * f;
        return (
          <g key={f}>
            <line x1={padL} x2={width - padR} y1={Y(v)} y2={Y(v)} stroke="#1d2730" strokeWidth="1" />
            <text x={padL - 6} y={Y(v) + 3} textAnchor="end" fontSize="9" fill="#6b7a87" fontFamily="monospace">{v.toFixed(2)}</text>
          </g>
        );
      })}
      {target !== undefined && Y(target) > padT && (
        <g>
          <line x1={padL} x2={width - padR} y1={Y(target)} y2={Y(target)} stroke="#f4604f" strokeWidth="1" strokeDasharray="6 4" />
          <text x={width - padR} y={Y(target) - 4} textAnchor="end" fontSize="9" fill="#f4604f" fontFamily="monospace">TARGET {target.toFixed(2)} (2× mandate)</text>
        </g>
      )}
      {[t0, (t0 + t1) / 2, t1].map((t, i) => (
        <text key={i} x={X(t)} y={height - 8} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} fontSize="9" fill="#6b7a87" fontFamily="monospace">{fmtTick(t)}</text>
      ))}
      {/* every scored candidate as a dot */}
      {points.map((p, i) => (
        <circle key={i} cx={X(p.t)} cy={Y(p.c)} r="2.2" fill={SOURCE_COLORS[p.source] ?? "#6b7a87"} opacity="0.55">
          <title>{`${p.name} · ${p.source} · ${p.c.toFixed(2)}`}</title>
        </circle>
      ))}
      {/* record step line */}
      <path d={area} fill="url(#recArea)" />
      <path d={d} fill="none" stroke="#e8b34b" strokeWidth="2" filter="url(#glow)" />
      {record.map((r, i) => (
        <g key={i}>
          <circle cx={X(r.t)} cy={Y(r.c)} r="3.6" fill="#e8b34b">
            <title>{`record: ${r.name} → ${r.c.toFixed(2)}`}</title>
          </circle>
        </g>
      ))}
      <text x={X(record[record.length - 1].t) + 6} y={Y(record[record.length - 1].c) - 6} fontSize="11" fill="#e8b34b" fontFamily="monospace" fontWeight="bold">
        {record[record.length - 1].c.toFixed(2)}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------- funnel
const FUNNEL_STAGES: { key: string; label: string }[] = [
  { key: "S2-train", label: "S2 train fit" },
  { key: "S3-walkforward", label: "S3 walk-forward" },
  { key: "S4-cross-symbol", label: "S4 cross-symbol" },
  { key: "S4-portfolio", label: "S4 portfolio" },
  { key: "S5-stats", label: "S5 statistics" },
  { key: "S5b-stress", label: "S5b stress" },
  { key: "S6-sealed", label: "S6 sealed" },
  { key: "S7-paper", label: "S7 paper" },
];

export function GauntletFunnel({ kills, alive, total }: { kills: Record<string, number>; alive: number; total: number }) {
  let reached = total - (kills["S1-penalty"] ?? 0) - (kills["S0-static"] ?? 0);
  const rows: { label: string; reached: number; killed: number }[] = [];
  for (const s of FUNNEL_STAGES) {
    const killed = kills[s.key] ?? 0;
    rows.push({ label: s.label, reached, killed });
    reached -= killed;
  }
  const max = Math.max(1, rows[0]?.reached ?? 1);
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-xs">
          <span className="hud w-28 shrink-0 !text-[9px]">{r.label}</span>
          <div className="flex-1 h-4 bg-ink rounded-sm overflow-hidden flex">
            <div className="h-full bg-gradient-to-r from-emerald-900 to-emerald-600/70" style={{ width: `${((r.reached - r.killed) / max) * 100}%` }} />
            <div className="h-full bg-gradient-to-r from-red-900/80 to-red-700/50" style={{ width: `${(r.killed / max) * 100}%` }} />
          </div>
          <span className="num w-16 text-right text-dim">{r.reached - r.killed}<span className="text-down">/{r.killed ? `-${r.killed}` : "0"}</span></span>
        </div>
      ))}
      <div className="flex items-center gap-2 text-xs pt-1">
        <span className="hud w-28 shrink-0 !text-[9px] text-gold">SURVIVORS</span>
        <span className={`num ${alive > 0 ? "text-gold" : "text-dim"}`}>{alive}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- attribution
export function SourceAttribution({ stats }: { stats: Record<string, { count: number; best: number; scored: number; deepest: string }> }) {
  const rows = Object.entries(stats).sort((a, b) => b[1].best - a[1].best);
  const maxBest = Math.max(0.01, ...rows.map(([, s]) => s.best));
  return (
    <div className="space-y-2">
      {rows.map(([source, s]) => (
        <div key={source} className="text-xs">
          <div className="flex justify-between mb-0.5">
            <span className="num" style={{ color: SOURCE_COLORS[source] ?? "#6b7a87" }}>{source}</span>
            <span className="num text-dim">{s.count} bred · best <span className="text-fg">{s.best > -9 ? s.best.toFixed(2) : "—"}</span></span>
          </div>
          <div className="h-2 bg-ink rounded-sm overflow-hidden">
            <div className="h-full rounded-sm" style={{ width: `${Math.max(2, (s.best / maxBest) * 100)}%`, background: `linear-gradient(90deg, ${SOURCE_COLORS[source] ?? "#6b7a87"}44, ${SOURCE_COLORS[source] ?? "#6b7a87"})` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function KillBars({ kills }: { kills: Record<string, number> }) {
  const rows = Object.entries(kills).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map(([, n]) => n));
  return (
    <div className="space-y-1.5">
      {rows.map(([stage, n]) => (
        <div key={stage} className="flex items-center gap-2 text-xs">
          <span className="hud w-28 shrink-0 !text-[9px]">{stage}</span>
          <div className="flex-1 h-3 bg-ink rounded-sm overflow-hidden">
            <div className="h-full bg-gradient-to-r from-red-950 to-down/80 rounded-sm" style={{ width: `${(n / max) * 100}%` }} />
          </div>
          <span className="num w-8 text-right text-dim">{n}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- activity
export interface ActivityItem { ts: number; kind: string; text: string; tone: "up" | "down" | "dim" | "gold" }

export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  return (
    <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
      {items.map((it, i) => (
        <div key={i} className="flex gap-2 text-xs items-baseline border-t border-edge/40 pt-1.5">
          <span className="num text-dim w-14 shrink-0">{timeAgo(it.ts)}</span>
          <span className={`num w-14 shrink-0 ${it.tone === "up" ? "text-up" : it.tone === "down" ? "text-down" : it.tone === "gold" ? "text-gold" : "text-dim"}`}>{it.kind}</span>
          <span className="text-dim leading-snug">{it.text}</span>
        </div>
      ))}
      {!items.length && <div className="hud py-4">quiet…</div>}
    </div>
  );
}

// ---------------------------------------------------------------- target gauge
export function TargetGauge({ current, target, label }: { current: number; target: number; label: string }) {
  const pct = Math.max(0, Math.min(100, (current / target) * 100));
  return (
    <div>
      <div className="flex justify-between items-baseline mb-1">
        <span className="hud">{label}</span>
        <span className="num text-xs"><span className="text-gold">{fmtNum(current)}</span><span className="text-dim"> / {fmtNum(target)}</span></span>
      </div>
      <div className="h-2.5 bg-ink rounded-full overflow-hidden border border-edge">
        <div className="h-full rounded-full bg-gradient-to-r from-amber-700 via-gold to-amber-300 transition-all duration-700" style={{ width: `${pct}%` }} />
      </div>
      <div className="num text-[10px] text-dim mt-0.5 text-right">{pct.toFixed(0)}% of the 2× mandate</div>
    </div>
  );
}
