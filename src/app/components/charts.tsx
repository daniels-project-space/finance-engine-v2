"use client";

// Dependency-free SVG charts for equity curves and drawdowns.

export interface Curve { t: number[]; eq: number[] }
export interface Series { name: string; color: string; curve: Curve }

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

let gradSeq = 0;

export function LineChart({ series, height = 180, yLabel = "equity (×)", logScale = false }: {
  series: Series[]; height?: number; yLabel?: string; logScale?: boolean;
}) {
  const all = series.filter((s) => s.curve?.t?.length > 1);
  if (!all.length) return <div className="hud py-4">no curve data</div>;
  const gid = `lcg${gradSeq++ % 64}`;
  const width = 720, padL = 46, padR = 8, padT = 8, padB = 22;
  const t0 = Math.min(...all.map((s) => s.curve.t[0]));
  const t1 = Math.max(...all.map((s) => s.curve.t[s.curve.t.length - 1]));
  const tx = (v: number) => logScale ? Math.log(Math.max(v, 1e-9)) : v;
  let lo = Infinity, hi = -Infinity;
  for (const s of all) for (const v of s.curve.eq) { lo = Math.min(lo, tx(v)); hi = Math.max(hi, tx(v)); }
  if (hi - lo < 1e-9) hi = lo + 1;
  const X = (ts: number) => padL + ((ts - t0) / Math.max(1, t1 - t0)) * (width - padL - padR);
  const Y = (v: number) => padT + (1 - (tx(v) - lo) / (hi - lo)) * (height - padT - padB);
  const yTicks = [lo, (lo + hi) / 2, hi].map((v) => (logScale ? Math.exp(v) : v));
  const xTicks = [t0, (t0 + t1) / 2, t1];

  const primarySeries = all[0];
  const areaPts = primarySeries.curve.t.map((ts, i) => `${X(ts).toFixed(1)},${Y(primarySeries.curve.eq[i]).toFixed(1)}`).join(" ");
  const baselineY = Y(logScale ? Math.exp(lo) : lo);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: height }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={primarySeries.color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={primarySeries.color} stopOpacity="0" />
        </linearGradient>
        <filter id={`${gid}glow`}><feGaussianBlur stdDeviation="1.8" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      {yTicks.map((v, i) => {
        const y = Y(v);
        return (
          <g key={i}>
            <line x1={padL} x2={width - padR} y1={y} y2={y} stroke="#1d2730" strokeWidth="1" />
            <text x={padL - 6} y={y + 3} textAnchor="end" fontSize="9" fill="#6b7a87" fontFamily="monospace">{v.toFixed(2)}</text>
          </g>
        );
      })}
      {/* 1.0 reference */}
      {lo <= tx(1) && tx(1) <= hi && <line x1={padL} x2={width - padR} y1={Y(1)} y2={Y(1)} stroke="#6b7a87" strokeWidth="0.7" strokeDasharray="3 4" />}
      {xTicks.map((ts, i) => (
        <text key={i} x={X(ts)} y={height - 6} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} fontSize="9" fill="#6b7a87" fontFamily="monospace">{fmtTime(ts)}</text>
      ))}
      {/* gradient area under the primary series */}
      <polygon points={`${X(primarySeries.curve.t[0]).toFixed(1)},${baselineY.toFixed(1)} ${areaPts} ${X(primarySeries.curve.t[primarySeries.curve.t.length - 1]).toFixed(1)},${baselineY.toFixed(1)}`} fill={`url(#${gid})`} />
      {all.map((s, idx) => (
        <polyline key={s.name}
          points={s.curve.t.map((ts, i) => `${X(ts).toFixed(1)},${Y(s.curve.eq[i]).toFixed(1)}`).join(" ")}
          fill="none" stroke={s.color} strokeWidth={idx === 0 ? 1.8 : 1.3} strokeLinejoin="round"
          opacity={idx === 0 ? 1 : 0.85} filter={idx === 0 ? `url(#${gid}glow)` : undefined} />
      ))}
      {/* terminal value labels */}
      {all.map((s, idx) => {
        const lastT = s.curve.t[s.curve.t.length - 1];
        const lastV = s.curve.eq[s.curve.eq.length - 1];
        return (
          <text key={`v${s.name}`} x={Math.min(X(lastT) + 4, width - 36)} y={Y(lastV) + 3 + idx * 0} fontSize="9" fill={s.color} fontFamily="monospace">{lastV.toFixed(2)}</text>
        );
      })}
      {/* legend */}
      {all.map((s, i) => (
        <g key={`l${s.name}`}>
          <rect x={padL + 4 + i * 150} y={padT} width="8" height="3" fill={s.color} />
          <text x={padL + 16 + i * 150} y={padT + 5} fontSize="9" fill="#9fb0bd" fontFamily="monospace">{s.name}</text>
        </g>
      ))}
      <text x={8} y={12} fontSize="8" fill="#6b7a87" fontFamily="monospace">{yLabel}</text>
    </svg>
  );
}

// ---------------------------------------------------------------- gauntlet trail
const TRAIL: { key: string; label: string }[] = [
  { key: "S0", label: "S0" }, { key: "S1", label: "S1" }, { key: "S2", label: "S2" },
  { key: "S3", label: "S3" }, { key: "S4", label: "S4" }, { key: "S5", label: "S5" },
  { key: "S5b", label: "S5b" }, { key: "S6", label: "S6" }, { key: "S7", label: "S7" },
];
const TRAIL_ORDER = ["S0", "S1", "S2", "S3", "S4", "S5", "S5b", "S6", "S7"];

/** Visual gauntlet outcome: green = passed, red = died here, dark = never reached. */
export function GauntletTrail({ failedStage, stage }: { failedStage?: string; stage: string }) {
  const aliveStages = new Set(["incubating", "eligible", "champion", "sealed_passed", "archived", "demoted"]);
  const survived = aliveStages.has(stage);
  let deathIdx = -1;
  if (failedStage) {
    const norm = failedStage.startsWith("S5b") ? "S5b" : failedStage.startsWith("S7") ? "S7" : failedStage.split("-")[0];
    deathIdx = TRAIL_ORDER.indexOf(norm);
  }
  return (
    <div className="flex items-center gap-1">
      {TRAIL.map((s, i) => {
        const state = survived ? (i <= 7 ? "pass" : stage === "champion" || stage === "eligible" ? "pass" : "active")
          : deathIdx === -1 ? "pending"
          : i < deathIdx ? "pass" : i === deathIdx ? "dead" : "unreached";
        return (
          <div key={s.key} className="flex flex-col items-center gap-0.5">
            <div className={`w-7 h-2 rounded-sm ${
              state === "pass" ? "bg-gradient-to-r from-emerald-700 to-emerald-500" :
              state === "dead" ? "bg-gradient-to-r from-red-700 to-red-500 shadow-[0_0_6px_#f4604f88]" :
              state === "active" ? "bg-gradient-to-r from-amber-700 to-amber-400 animate-pulse" :
              "bg-edge"
            }`} />
            <span className={`num text-[8px] ${state === "dead" ? "text-down" : state === "pass" ? "text-up/70" : "text-dim"}`}>{s.label}</span>
          </div>
        );
      })}
    </div>
  );
}

export function DrawdownChart({ curve, height = 90 }: { curve: Curve; height?: number }) {
  if (!curve?.t?.length) return null;
  const width = 720, padL = 46, padR = 8, padT = 4, padB = 16;
  const dd: number[] = [];
  let peak = -Infinity;
  for (const v of curve.eq) { peak = Math.max(peak, v); dd.push(v / peak - 1); }
  const minDD = Math.min(...dd, -0.01);
  const t0 = curve.t[0], t1 = curve.t[curve.t.length - 1];
  const X = (ts: number) => padL + ((ts - t0) / Math.max(1, t1 - t0)) * (width - padL - padR);
  const Y = (v: number) => padT + (v / minDD) * (height - padT - padB);
  const pts = curve.t.map((ts, i) => `${X(ts).toFixed(1)},${Y(dd[i]).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: height }}>
      <text x={8} y={12} fontSize="8" fill="#6b7a87" fontFamily="monospace">drawdown</text>
      <text x={padL - 6} y={Y(minDD) + 3} textAnchor="end" fontSize="9" fill="#f4604f" fontFamily="monospace">{(minDD * 100).toFixed(0)}%</text>
      <polygon points={`${X(t0)},${Y(0)} ${pts} ${X(t1)},${Y(0)}`} fill="#f4604f22" stroke="none" />
      <polyline points={pts} fill="none" stroke="#f4604f" strokeWidth="1" />
    </svg>
  );
}

export function MiniCurve({ curve, width = 130, height = 34 }: { curve?: Curve; width?: number; height?: number }) {
  if (!curve?.t?.length) return <span className="hud">—</span>;
  const lo = Math.min(...curve.eq), hi = Math.max(...curve.eq);
  const span = hi - lo || 1;
  const pts = curve.eq.map((v, i) => `${(i / Math.max(1, curve.eq.length - 1)) * width},${height - 2 - ((v - lo) / span) * (height - 4)}`).join(" ");
  const up = curve.eq[curve.eq.length - 1] >= curve.eq[0];
  return (
    <svg width={width} height={height} className="block">
      <polyline points={pts} fill="none" stroke={up ? "#2dd4a7" : "#f4604f"} strokeWidth="1.2" />
    </svg>
  );
}
