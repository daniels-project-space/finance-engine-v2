"use client";

const STAGE_COLORS: Record<string, string> = {
  generated: "text-dim border-edge",
  queued: "text-sky-400 border-sky-900",
  gauntlet: "text-sky-300 border-sky-800",
  failed: "text-down border-red-900",
  graveyard: "text-dim border-edge",
  sealed_passed: "text-up border-emerald-900",
  incubating: "text-amber-300 border-amber-900",
  eligible: "text-up border-emerald-800",
  champion: "text-gold border-yellow-700",
  demoted: "text-orange-400 border-orange-900",
  archived: "text-dim border-edge",
};

export function StageBadge({ stage }: { stage: string }) {
  return (
    <span className={`num inline-block px-2 py-0.5 text-[10px] uppercase tracking-wider border rounded ${STAGE_COLORS[stage] ?? "text-dim border-edge"}`}>
      {stage.replace("_", " ")}
    </span>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" | "gold" }) {
  const color = tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "gold" ? "text-gold" : "text-fg";
  return (
    <div>
      <div className="hud mb-1">{label}</div>
      <div className={`num text-xl ${color}`}>{value}</div>
    </div>
  );
}

export function Sparkline({ values, width = 220, height = 48, tone }: { values: number[]; width?: number; height?: number; tone?: "auto" }) {
  if (!values.length) return <div className="hud">no data</div>;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * width},${height - ((v - min) / span) * (height - 4) - 2}`).join(" ");
  const up = values[values.length - 1] >= values[0];
  const color = up ? "#2dd4a7" : "#f4604f";
  return (
    <svg width={width} height={height} className="block">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

export function fmtPct(x: number | undefined, digits = 1): string {
  if (x === undefined || Number.isNaN(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtNum(x: number | undefined, digits = 2): string {
  if (x === undefined || Number.isNaN(x)) return "—";
  return x.toFixed(digits);
}

export function timeAgo(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
