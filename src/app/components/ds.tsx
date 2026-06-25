"use client";

// ============================================================ DESIGN SYSTEM
// One canonical vocabulary, reused on every page. Numbers are the heroes (mono),
// labels are terse (sans). All SVG is NaN-guarded.

import Link from "next/link";
import type { ReactNode } from "react";

// ---------------------------------------------------------------- formatters
export function fmt(x: number | null | undefined, d = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return x.toFixed(d);
}
export function pct(x: number | null | undefined, d = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(d)}%`;
}
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}
export function ago(ts: number): string {
  if (!ts) return "—";
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// ---------------------------------------------------------------- Panel
export function Panel({ title, right, children, className = "", pad = "p-4", hover = false }: {
  title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; pad?: string; hover?: boolean;
}) {
  return (
    <section className={`panel ${hover ? "panel-h" : ""} ${pad} ${className}`}>
      {(title || right) && (
        <div className="flex items-center justify-between gap-3 mb-3">
          {title ? <div className="hud">{title}</div> : <span />}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- StatTile
// The one stat component: big mono number, tiny label, optional unit/delta/spark.
export function Stat({ label, value, unit, tone = "fg", sub, spark, size = "md" }: {
  label: string; value: ReactNode; unit?: string; tone?: Tone; sub?: ReactNode;
  spark?: number[]; size?: "sm" | "md" | "lg";
}) {
  const sz = size === "lg" ? "text-[26px]" : size === "sm" ? "text-base" : "text-[19px]";
  return (
    <div className="min-w-0">
      <div className="hud mb-1 truncate">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className={`num ${sz} leading-none ${toneText(tone)}`}>{value}</span>
        {unit && <span className="num text-[10px] text-dim">{unit}</span>}
      </div>
      {sub && <div className="num text-[10px] text-dim mt-1">{sub}</div>}
      {spark && spark.length > 1 && <div className="mt-1.5"><Spark values={spark} width={120} height={22} tone={tone} /></div>}
    </div>
  );
}

type Tone = "fg" | "dim" | "accent" | "up" | "down" | "info" | "promo";
function toneText(t: Tone): string {
  return t === "accent" ? "text-accent" : t === "up" ? "text-up" : t === "down" ? "text-down"
    : t === "info" ? "text-info" : t === "promo" ? "text-promo" : t === "dim" ? "text-dim" : "text-fg";
}
function toneHex(t: Tone): string {
  return t === "accent" ? "#f4b740" : t === "up" ? "#34d399" : t === "down" ? "#f4604f"
    : t === "info" ? "#5cc8ff" : t === "promo" ? "#c084fc" : t === "dim" ? "#5e6c7a" : "#dbe3ec";
}

// ---------------------------------------------------------------- Pill / badge
const STAGE_TONE: Record<string, Tone> = {
  generated: "dim", queued: "info", gauntlet: "info", failed: "down", graveyard: "dim",
  sealed_passed: "up", incubating: "accent", eligible: "up", champion: "promo", demoted: "down", archived: "dim",
};
export function StageBadge({ stage }: { stage: string }) {
  const tone = STAGE_TONE[stage] ?? "dim";
  return <span className={`pill ${toneText(tone)}`}>{stage.replace("_", " ")}</span>;
}
export function Pill({ children, tone = "dim", soft = false }: { children: ReactNode; tone?: Tone; soft?: boolean }) {
  return <span className={`pill ${soft ? "pill-soft text-dim" : toneText(tone)}`}>{children}</span>;
}

// ---------------------------------------------------------------- Bar (progress)
export function Bar({ value, max = 1, tone = "accent", height = 6, track = true }: {
  value: number; max?: number; tone?: Tone; height?: number; track?: boolean;
}) {
  const w = Math.max(0, Math.min(100, (max > 0 ? value / max : 0) * 100));
  return (
    <div className={`w-full overflow-hidden rounded-full ${track ? "bg-ink border border-edge" : ""}`} style={{ height }}>
      <div className="h-full rounded-full transition-[width] duration-700"
        style={{ width: `${w}%`, background: `linear-gradient(90deg, ${toneHex(tone)}66, ${toneHex(tone)})` }} />
    </div>
  );
}

// ---------------------------------------------------------------- Spark
export function Spark({ values, width = 120, height = 24, tone }: {
  values: number[]; width?: number; height?: number; tone?: Tone;
}) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return <span className="hud">—</span>;
  const lo = Math.min(...v), hi = Math.max(...v);
  const span = hi - lo || 1;
  const pts = v.map((x, i) => {
    const px = (i / (v.length - 1)) * (width - 2) + 1;
    const py = height - 2 - ((x - lo) / span) * (height - 4);
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  }).join(" ");
  const up = v[v.length - 1] >= v[0];
  const color = tone ? toneHex(tone) : up ? "#34d399" : "#f4604f";
  return (
    <svg width={width} height={height} className="block overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------- Equity chart
export interface Curve { t: number[]; eq: number[] }
export interface Series { name: string; color: string; curve: Curve; dash?: boolean }

let _g = 0;
const monthFmt = (ts: number) => { const d = new Date(ts); return `${d.getUTCFullYear()}·${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };

// Guard a curve: keep only finite, positive-progression points, aligned t/eq.
function clean(c?: Curve): Curve | null {
  if (!c?.t?.length || !c.eq?.length) return null;
  const t: number[] = [], eq: number[] = [];
  const n = Math.min(c.t.length, c.eq.length);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(c.t[i]) && Number.isFinite(c.eq[i])) { t.push(c.t[i]); eq.push(c.eq[i]); }
  }
  return t.length > 1 ? { t, eq } : null;
}

export function Chart({ series, height = 220, yLabel = "growth of $1", showArea = true }: {
  series: Series[]; height?: number; yLabel?: string; showArea?: boolean;
}) {
  const all = series.map((s) => ({ ...s, curve: clean(s.curve) })).filter((s): s is Series => !!s.curve);
  if (!all.length) return <div className="well h-[var(--h)] flex items-center justify-center" style={{ ["--h" as string]: `${height}px` }}><span className="hud">no curve data</span></div>;
  const gid = `cg${_g++ % 64}`;
  const width = 760, padL = 44, padR = 46, padT = 12, padB = 22;
  let t0 = Infinity, t1 = -Infinity, lo = Infinity, hi = -Infinity;
  for (const s of all) {
    t0 = Math.min(t0, s.curve.t[0]); t1 = Math.max(t1, s.curve.t[s.curve.t.length - 1]);
    for (const v of s.curve.eq) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (hi - lo < 1e-9) hi = lo + 1;
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const X = (ts: number) => padL + ((ts - t0) / Math.max(1, t1 - t0)) * (width - padL - padR);
  const Y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (height - padT - padB);
  const yTicks = [lo, (lo + hi) / 2, hi];
  const xTicks = [t0, (t0 + t1) / 2, t1];
  const primary = all[0];
  const baseY = Y(lo);
  const area = `${X(primary.curve.t[0]).toFixed(1)},${baseY.toFixed(1)} ` +
    primary.curve.t.map((ts, i) => `${X(ts).toFixed(1)},${Y(primary.curve.eq[i]).toFixed(1)}`).join(" ") +
    ` ${X(primary.curve.t[primary.curve.t.length - 1]).toFixed(1)},${baseY.toFixed(1)}`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full block" style={{ maxHeight: height }} preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={primary.color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={primary.color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {yTicks.map((v, i) => (
        <g key={i}>
          <line x1={padL} x2={width - padR} y1={Y(v)} y2={Y(v)} stroke="#1e2730" strokeWidth="1" />
          <text x={padL - 6} y={Y(v) + 3} textAnchor="end" fontSize="8.5" fill="#5e6c7a" fontFamily="var(--font-mono)">{v.toFixed(2)}</text>
        </g>
      ))}
      {lo <= 1 && 1 <= hi && <line x1={padL} x2={width - padR} y1={Y(1)} y2={Y(1)} stroke="#5e6c7a" strokeWidth="0.7" strokeDasharray="2 4" />}
      {xTicks.map((ts, i) => (
        <text key={i} x={X(ts)} y={height - 6} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} fontSize="8.5" fill="#5e6c7a" fontFamily="var(--font-mono)">{monthFmt(ts)}</text>
      ))}
      {showArea && <polygon points={area} fill={`url(#${gid})`} />}
      {all.map((s, idx) => (
        <polyline key={s.name}
          points={s.curve.t.map((ts, i) => `${X(ts).toFixed(1)},${Y(s.curve.eq[i]).toFixed(1)}`).join(" ")}
          fill="none" stroke={s.color} strokeWidth={idx === 0 ? 1.9 : 1.3}
          strokeDasharray={s.dash ? "4 3" : undefined}
          opacity={idx === 0 ? 1 : 0.8} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {all.map((s) => {
        const lv = s.curve.eq[s.curve.eq.length - 1];
        return <text key={`v${s.name}`} x={width - padR + 4} y={Y(lv) + 3} fontSize="9" fill={s.color} fontFamily="var(--font-mono)">{lv.toFixed(2)}×</text>;
      })}
      {/* legend along the top, right-aligned block so it never sits on the y-axis */}
      {(() => {
        const itemW = 96;
        const totalW = all.length * itemW;
        const startX = Math.max(padL + 70, width - padR - totalW);
        return all.map((s, i) => (
          <g key={`l${s.name}`} transform={`translate(${startX + i * itemW}, ${padT + 1})`}>
            <rect x={0} y={-3} width="9" height="2.5" fill={s.color} />
            <text x={13} y={1} fontSize="8.5" fill="#92a1b0" fontFamily="var(--font-mono)">{s.name}</text>
          </g>
        ));
      })()}
      <text x={6} y={11} fontSize="7.5" fill="#3a4651" fontFamily="var(--font-mono)">{yLabel}</text>
    </svg>
  );
}

// ---------------------------------------------------------------- empty state
export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-6 text-center hud">{children}</div>;
}

// link wrapper for rows
export function RowLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return <Link href={href} className={className}>{children}</Link>;
}
