"use client";

// ============================================================ DESIGN SYSTEM v2
// One canonical vocabulary, reused on every page. Numbers are the heroes (mono),
// labels terse (sans). Modern + calm: soft surfaces, generous space, faint grid.
// All SVG is NaN-guarded.

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

// ---------------------------------------------------------------- tones
export type Tone = "fg" | "dim" | "accent" | "up" | "down" | "info" | "promo";
export function toneText(t: Tone): string {
  return t === "accent" ? "text-accent" : t === "up" ? "text-up" : t === "down" ? "text-down"
    : t === "info" ? "text-info" : t === "promo" ? "text-promo" : t === "dim" ? "text-dim" : "text-fg";
}
export function toneHex(t: Tone): string {
  return t === "accent" ? "#f5b932" : t === "up" ? "#3ddb9e" : t === "down" ? "#fb6f5d"
    : t === "info" ? "#5cc8ff" : t === "promo" ? "#c191fb" : t === "dim" ? "#586573" : "#e2e8f0";
}

// ---------------------------------------------------------------- Panel
export function Panel({ title, right, children, className = "", pad = "p-5", hover = false }: {
  title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; pad?: string; hover?: boolean;
}) {
  return (
    <section className={`panel ${hover ? "panel-h" : ""} ${pad} ${className}`}>
      {(title || right) && (
        <div className="flex items-center justify-between gap-3 mb-4">
          {title ? <div className="hud">{title}</div> : <span />}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- Stat tile
export function Stat({ label, value, unit, tone = "fg", sub, spark, size = "md" }: {
  label: string; value: ReactNode; unit?: string; tone?: Tone; sub?: ReactNode;
  spark?: number[]; size?: "sm" | "md" | "lg";
}) {
  const sz = size === "lg" ? "text-[28px]" : size === "sm" ? "text-[17px]" : "text-[20px]";
  return (
    <div className="min-w-0">
      <div className="hud mb-1.5 truncate">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className={`num ${sz} leading-none ${toneText(tone)}`}>{value}</span>
        {unit && <span className="num text-[10px] text-dim">{unit}</span>}
      </div>
      {sub && <div className="num text-[10px] text-dim mt-1.5">{sub}</div>}
      {spark && spark.length > 1 && <div className="mt-2"><Spark values={spark} width={120} height={22} tone={tone} /></div>}
    </div>
  );
}

// adaptive metric grid: render only the metrics that EXIST (skip undefined),
// so an early-death candidate shows its real numbers, never a wall of dashes.
export interface MetricDef { label: string; key: string; kind?: "num" | "pct"; tone?: Tone | ((v: number) => Tone); digits?: number; unit?: string }
export function MetricGrid({ metrics, defs, cols = "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6" }: {
  metrics: Record<string, number>; defs: MetricDef[]; cols?: string;
}) {
  const present = defs.filter((d) => metrics[d.key] !== undefined && Number.isFinite(metrics[d.key]));
  if (!present.length) return <div className="hud py-2">no metrics recorded for this stage</div>;
  return (
    <div className={`grid ${cols} gap-x-5 gap-y-4`}>
      {present.map((d) => {
        const v = metrics[d.key];
        const tone: Tone = typeof d.tone === "function" ? d.tone(v) : (d.tone ?? "fg");
        const val = d.kind === "pct" ? pct(v, d.digits ?? 0) : fmt(v, d.digits ?? 2);
        return <Stat key={d.key} label={d.label} value={val} tone={tone} unit={d.unit} size="sm" />;
      })}
    </div>
  );
}

// key→value inline row
export function KV({ k, v, tone = "fg" }: { k: string; v: ReactNode; tone?: Tone }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="hud">{k}</span>
      <span className={`num text-xs ${toneText(tone)}`}>{v}</span>
    </div>
  );
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
  return <span className={`pill ${soft ? "pill-soft" : toneText(tone)}`}>{children}</span>;
}

// ---------------------------------------------------------------- Bar
export function Bar({ value, max = 1, tone = "accent", height = 6 }: {
  value: number; max?: number; tone?: Tone; height?: number;
}) {
  const w = Math.max(0, Math.min(100, (max > 0 ? value / max : 0) * 100));
  return (
    <div className="w-full overflow-hidden rounded-full bg-[#ffffff0a]" style={{ height }}>
      <div className="h-full rounded-full transition-[width] duration-700"
        style={{ width: `${w}%`, background: `linear-gradient(90deg, ${toneHex(tone)}66, ${toneHex(tone)})` }} />
    </div>
  );
}

// ---------------------------------------------------------------- Spark
export function Spark({ values, width = 120, height = 24, tone, fill = false }: {
  values: number[]; width?: number; height?: number; tone?: Tone; fill?: boolean;
}) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return <span className="hud">—</span>;
  const lo = Math.min(...v), hi = Math.max(...v);
  const span = hi - lo || 1;
  const xy = (x: number, i: number): [number, number] => [(i / (v.length - 1)) * (width - 2) + 1, height - 2 - ((x - lo) / span) * (height - 4)];
  const pts = v.map((x, i) => { const [px, py] = xy(x, i); return `${px.toFixed(1)},${py.toFixed(1)}`; }).join(" ");
  const up = v[v.length - 1] >= v[0];
  const color = tone ? toneHex(tone) : up ? "#3ddb9e" : "#fb6f5d";
  return (
    <svg width={width} height={height} className="block overflow-visible">
      {fill && <polygon points={`1,${height - 1} ${pts} ${width - 1},${height - 1}`} fill={color} opacity="0.1" />}
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------- Equity chart
export interface Curve { t: number[]; eq: number[] }
export interface Series { name: string; color: string; curve: Curve; dash?: boolean }

let _g = 0;
const monthFmt = (ts: number) => { const d = new Date(ts); return `${d.getUTCFullYear()}·${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };

function clean(c?: Curve): Curve | null {
  if (!c?.t?.length || !c.eq?.length) return null;
  const t: number[] = [], eq: number[] = [];
  const n = Math.min(c.t.length, c.eq.length);
  for (let i = 0; i < n; i++) if (Number.isFinite(c.t[i]) && Number.isFinite(c.eq[i])) { t.push(c.t[i]); eq.push(c.eq[i]); }
  return t.length > 1 ? { t, eq } : null;
}

export function Chart({ series, height = 220, yLabel = "growth of $1", showArea = true }: {
  series: Series[]; height?: number; yLabel?: string; showArea?: boolean;
}) {
  const all = series.map((s) => ({ ...s, curve: clean(s.curve) })).filter((s): s is Series => !!s.curve);
  if (!all.length) return <div className="well flex items-center justify-center" style={{ height }}><span className="hud">no curve data</span></div>;
  const gid = `cg${_g++ % 64}`;
  const width = 760, padL = 42, padR = 48, padT = 14, padB = 24;
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
          <stop offset="0%" stopColor={primary.color} stopOpacity="0.16" />
          <stop offset="100%" stopColor={primary.color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {yTicks.map((v, i) => (
        <g key={i}>
          <line x1={padL} x2={width - padR} y1={Y(v)} y2={Y(v)} stroke="#ffffff0a" strokeWidth="1" />
          <text x={padL - 6} y={Y(v) + 3} textAnchor="end" fontSize="8.5" fill="#586573" fontFamily="var(--font-mono)">{v.toFixed(2)}</text>
        </g>
      ))}
      {lo <= 1 && 1 <= hi && <line x1={padL} x2={width - padR} y1={Y(1)} y2={Y(1)} stroke="#586573" strokeWidth="0.6" strokeDasharray="2 5" />}
      {xTicks.map((ts, i) => (
        <text key={i} x={X(ts)} y={height - 7} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} fontSize="8.5" fill="#586573" fontFamily="var(--font-mono)">{monthFmt(ts)}</text>
      ))}
      {showArea && <polygon points={area} fill={`url(#${gid})`} />}
      {all.map((s, idx) => (
        <polyline key={s.name}
          points={s.curve.t.map((ts, i) => `${X(ts).toFixed(1)},${Y(s.curve.eq[i]).toFixed(1)}`).join(" ")}
          fill="none" stroke={s.color} strokeWidth={idx === 0 ? 2 : 1.3}
          strokeDasharray={s.dash ? "4 3" : undefined}
          opacity={idx === 0 ? 1 : 0.75} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {all.map((s) => {
        const lv = s.curve.eq[s.curve.eq.length - 1];
        return <text key={`v${s.name}`} x={width - padR + 4} y={Y(lv) + 3} fontSize="9" fill={s.color} fontFamily="var(--font-mono)">{lv.toFixed(2)}×</text>;
      })}
      {(() => {
        const itemW = 96;
        const startX = Math.max(padL + 64, width - padR - all.length * itemW);
        return all.map((s, i) => (
          <g key={`l${s.name}`} transform={`translate(${startX + i * itemW}, ${padT - 4})`}>
            <rect x={0} y={-3} width="9" height="2.5" rx="1" fill={s.color} />
            <text x={13} y={1} fontSize="8.5" fill="#8b9aab" fontFamily="var(--font-mono)">{s.name}</text>
          </g>
        ));
      })()}
      <text x={6} y={11} fontSize="7.5" fill="#364250" fontFamily="var(--font-mono)">{yLabel}</text>
    </svg>
  );
}

// drawdown underwater chart (NaN-guarded)
export function Drawdown({ curve, height = 90 }: { curve?: Curve; height?: number }) {
  const c = clean(curve);
  if (!c) return null;
  const width = 760, padL = 42, padR = 48, padT = 8, padB = 16;
  const dd: number[] = []; let peak = -Infinity;
  for (const v of c.eq) { peak = Math.max(peak, v); dd.push(peak > 0 ? v / peak - 1 : 0); }
  const minDD = Math.min(-0.001, ...dd);
  const t0 = c.t[0], t1 = c.t[c.t.length - 1];
  const X = (ts: number) => padL + ((ts - t0) / Math.max(1, t1 - t0)) * (width - padL - padR);
  const Y = (v: number) => padT + (v / minDD) * (height - padT - padB);
  const pts = c.t.map((ts, i) => `${X(ts).toFixed(1)},${Y(dd[i]).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full block" style={{ maxHeight: height }}>
      <text x={6} y={11} fontSize="7.5" fill="#364250" fontFamily="var(--font-mono)">drawdown</text>
      <text x={padL - 6} y={Y(minDD) + 3} textAnchor="end" fontSize="8.5" fill="#fb6f5d" fontFamily="var(--font-mono)">{(minDD * 100).toFixed(0)}%</text>
      <polygon points={`${X(t0)},${Y(0)} ${pts} ${X(t1)},${Y(0)}`} fill="#fb6f5d1c" />
      <polyline points={pts} fill="none" stroke="#fb6f5d" strokeWidth="1.1" />
    </svg>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-8 text-center hud">{children}</div>;
}
