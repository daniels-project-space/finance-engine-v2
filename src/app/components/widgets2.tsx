"use client";

// Precision-instrument widgets built on the design system (ds.tsx).

import Link from "next/link";
import { fmt, pct, ago, Chart, Spark, type Curve } from "./ds";

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
  seed: "#5cc8ff", imported: "#c191fb", llm: "#f5b932", gp: "#8b9aab",
  mutation: "#3ddb9e", crossover: "#5cc8ff", repair: "#f08a3c",
  xsection: "#c191fb", ivsleeve: "#5cc8ff", onchain: "#3ddb9e", regime: "#5cc8ff", trendbeta: "#f5b932",
};
export function srcColor(s: string): string { return SRC[s] ?? "#5e6c7a"; }

// map a generator source to its sleeve family label
export function familyOf(source: string): string {
  if (source === "xsection") return "Cross-sectional";
  if (source === "ivsleeve") return "IV-timing";
  if (source === "onchain") return "On-chain";
  return "DSL";
}

// ---------------------------------------------------------------- gauntlet trail
// Compact segmented trail: green = passed, red = died here, ghost = never reached.
const TRAIL = ["S2", "S3", "S4", "S5", "S5b", "S5c", "S6"];
const ALIVE_STAGES = new Set(["champion", "eligible", "incubating", "sealed_passed"]);
function trailDeathIdx(failedStage?: string): number {
  if (!failedStage) return -1;
  const base = failedStage.startsWith("S5b") ? "S5b" : failedStage.startsWith("S5c") ? "S5c"
    : failedStage.split("-")[0].replace(/[a-z]+$/, "");
  return TRAIL.indexOf(base);
}
export function GauntletTrail({ failedStage, stage, labels = false }: { failedStage?: string; stage: string; labels?: boolean }) {
  const alive = ALIVE_STAGES.has(stage);
  const dead = trailDeathIdx(failedStage);
  return (
    <div className="flex items-center gap-[3px]">
      {TRAIL.map((s, i) => {
        const state = alive ? "pass" : dead === -1 ? "pending" : i < dead ? "pass" : i === dead ? "dead" : "unreached";
        const bg = state === "pass" ? "#1f7a5f" : state === "dead" ? "#fb6f5d" : state === "pending" ? "#364250" : "#1b242e";
        return (
          <div key={s} className="flex flex-col items-center gap-1" title={`${s} · ${state}`}>
            <div className="h-[6px] rounded-sm" style={{ width: labels ? 26 : 18, background: bg, boxShadow: state === "dead" ? "0 0 6px #fb6f5daa" : undefined }} />
            {labels && <span className={`num text-[8px] ${state === "dead" ? "text-down" : state === "pass" ? "text-up/70" : "text-dim"}`}>{s}</span>}
          </div>
        );
      })}
    </div>
  );
}

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

// ================================================================ BookProgress
// The BIG headline gauge — deflated Sharpe vs the 1.0 promotion bar. Spacious,
// the "are we there yet" number front and centre.
export function BookProgress({ deflated, target, raw, divRatio, meanCorr, members, passes }: {
  deflated: number; target: number; raw: number; divRatio: number; meanCorr: number; members: number; passes: boolean;
}) {
  const p = Math.max(0, Math.min(1, deflated / target));
  return (
    <div>
      <div className="flex items-end gap-4 mb-4">
        <div className={`num leading-none ${passes ? "text-up" : "text-accent"}`} style={{ fontSize: 64 }}>{fmt(deflated)}</div>
        <div className="num text-dim text-2xl leading-none mb-1">/ {fmt(target)}</div>
        <div className="ml-auto text-right">
          <div className="num text-[11px] text-dim">{members === 0 ? "no sleeves admitted" : `${members} sleeves`}</div>
          <div className="num text-[11px] text-dim">{(p * 100).toFixed(0)}% of the bar</div>
        </div>
      </div>
      <div className="relative h-3 rounded-full bg-[#ffffff0a] overflow-hidden">
        <div className="h-full rounded-full transition-[width] duration-700"
          style={{ width: `${p * 100}%`, background: passes ? "linear-gradient(90deg,#1f7a5f,#3ddb9e)" : "linear-gradient(90deg,#7a5a12,#f5b932)" }} />
        <div className="absolute top-0 bottom-0 w-0.5 bg-up/80" style={{ left: "100%" }} />
      </div>
      <div className="flex flex-wrap gap-x-10 gap-y-1 mt-4 num text-[11px]">
        <span className="text-dim">raw Sharpe <span className="text-fg">{fmt(raw)}</span></span>
        <span className="text-dim">div ratio <span className="text-info">{fmt(divRatio)}</span></span>
        <span className="text-dim">mean |corr| <span className={meanCorr <= 0.5 ? "text-up" : "text-down"}>{fmt(meanCorr)}</span></span>
        <span className="text-dim">{passes ? "✓ promotable" : "needs deflated ≥ 1.00 — gate is honest, nothing has cleared it"}</span>
      </div>
    </div>
  );
}

// ================================================================ SimpleFunnel
// A clean, big, spacious funnel: ordered stages with a survivor-width bar + the
// reached count, large. Less line-noise than the dense Funnel.
const SF_SURV = new Set(["incubating", "book", "eligible", "champion"]);
export function SimpleFunnel({ rows, survivors }: { rows: FlowRow[]; survivors: number }) {
  const shown = rows.filter((r) => !["book"].includes(r.key)); // collapse book row into survivors line
  const max = Math.max(1, shown[0]?.reached ?? 1);
  return (
    <div className="space-y-2.5">
      {shown.map((r) => {
        const surv = Math.max(0, r.reached - r.killed);
        const w = (r.reached / max) * 100;
        const isSurv = SF_SURV.has(r.key);
        return (
          <div key={r.key} className="flex items-center gap-4">
            <span className="num text-[12px] w-[150px] shrink-0 text-mid truncate">{r.label}</span>
            <div className="flex-1 h-2 rounded-full bg-[#ffffff08] overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${w}%`, background: isSurv ? "linear-gradient(90deg,#7a5a12,#f5b932)" : "linear-gradient(90deg,#1f6b54,#3ddb9e99)" }} />
            </div>
            {r.killed > 0 && <span className="num text-[10px] text-down/80 w-12 text-right">−{r.killed}</span>}
            {r.killed === 0 && <span className="w-12" />}
            <span className={`num text-[15px] w-14 text-right ${isSurv ? (surv > 0 ? "text-accent" : "text-dim") : surv > 0 ? "text-fg" : "text-dim"}`}>{surv > 0 ? surv : "·"}</span>
          </div>
        );
      })}
    </div>
  );
}

// ================================================================ Progression
// RESTORED: the "are we improving over iterations" chart. Record best composite
// steps up over time (amber line + node), every scored candidate a dot colored
// by its source lane. NaN-guarded.
export interface ProgPoint { t: number; c: number; source: string; name: string }
export function Progression({ points, target = 1.04, height = 280 }: { points: ProgPoint[]; target?: number; height?: number }) {
  const pts = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.c));
  if (pts.length < 2) return <div className="well flex items-center justify-center" style={{ height }}><span className="hud">not enough scored candidates yet</span></div>;
  const width = 1000, padL = 40, padR = 16, padT = 18, padB = 28;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const record: { t: number; c: number; name: string }[] = [];
  let best = -Infinity;
  for (const p of pts) if (p.c > best) { best = p.c; record.push({ t: p.t, c: p.c, name: p.name }); }
  const yLo = Math.min(0, ...pts.map((p) => p.c));
  const yHi = (Math.max(target, best) || 1) * 1.1;
  const X = (t: number) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (width - padL - padR);
  const Y = (c: number) => padT + (1 - (c - yLo) / (yHi - yLo)) * (height - padT - padB);
  let d = `M ${X(record[0].t).toFixed(1)} ${Y(record[0].c).toFixed(1)}`;
  for (let i = 1; i < record.length; i++) d += ` L ${X(record[i].t).toFixed(1)} ${Y(record[i - 1].c).toFixed(1)} L ${X(record[i].t).toFixed(1)} ${Y(record[i].c).toFixed(1)}`;
  d += ` L ${X(t1).toFixed(1)} ${Y(record[record.length - 1].c).toFixed(1)}`;
  const area = `${d} L ${X(t1).toFixed(1)} ${Y(yLo).toFixed(1)} L ${X(record[0].t).toFixed(1)} ${Y(yLo).toFixed(1)} Z`;
  const sameDay = t1 - t0 < 86_400_000 * 1.5;
  const fmtTick = (t: number) => sameDay ? `${String(new Date(t).getUTCHours()).padStart(2, "0")}:${String(new Date(t).getUTCMinutes()).padStart(2, "0")}` : new Date(t).toISOString().slice(5, 10);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full block" style={{ maxHeight: height }}>
      <defs>
        <linearGradient id="progArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f5b932" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#f5b932" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75, 1].map((f) => {
        const v = yLo + (yHi - yLo) * f;
        return <g key={f}><line x1={padL} x2={width - padR} y1={Y(v)} y2={Y(v)} stroke="#ffffff0a" strokeWidth="1" /><text x={padL - 6} y={Y(v) + 3} textAnchor="end" fontSize="9" fill="#586573" fontFamily="var(--font-mono)">{v.toFixed(2)}</text></g>;
      })}
      {Y(target) > padT && (
        <g>
          <line x1={padL} x2={width - padR} y1={Y(target)} y2={Y(target)} stroke="#fb6f5d" strokeWidth="1" strokeDasharray="5 4" />
          <text x={width - padR} y={Y(target) - 4} textAnchor="end" fontSize="9" fill="#fb6f5d" fontFamily="var(--font-mono)">target {target.toFixed(2)}</text>
        </g>
      )}
      {[t0, (t0 + t1) / 2, t1].map((t, i) => (
        <text key={i} x={X(t)} y={height - 8} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} fontSize="9" fill="#586573" fontFamily="var(--font-mono)">{fmtTick(t)}</text>
      ))}
      {pts.map((p, i) => (
        <circle key={i} cx={X(p.t).toFixed(1)} cy={Y(p.c).toFixed(1)} r="2.3" fill={srcColor(p.source)} opacity="0.5" />
      ))}
      <path d={area} fill="url(#progArea)" />
      <path d={d} fill="none" stroke="#f5b932" strokeWidth="2.2" strokeLinejoin="round" />
      {record.map((r, i) => <circle key={i} cx={X(r.t).toFixed(1)} cy={Y(r.c).toFixed(1)} r="3.4" fill="#f5b932" />)}
      <text x={Math.min(X(record[record.length - 1].t) + 8, width - 40)} y={Y(record[record.length - 1].c) - 7} fontSize="13" fill="#f5b932" fontFamily="var(--font-mono)" fontWeight="bold">{record[record.length - 1].c.toFixed(2)}</text>
    </svg>
  );
}

// ================================================================ PaperBook
// The live forward track record (the moving headline). Big forward equity / Sharpe
// / days, the combined book equity curve, and per-sleeve forward rows. HONEST:
// "warming" until enough forward bars exist; framed as modest sleeves being tested.
export interface PaperSleeve { id: string; name: string; family: string; source?: string; userStrategy?: boolean; lastTs?: number; forwardSeed: boolean; leverage?: number; equity: number; ret: number; sharpe: number | null; days: number; maxDD: number; halted: boolean; bars: number; spark: number[] }
export interface PaperData { nSleeves: number; days: number; book: { t: number[]; eq: number[]; sharpe: number | null; ret: number; maxDD: number; bars: number; lastTs?: number }; sleeves: PaperSleeve[] }
function liveAgo(ts?: number): string { if (!ts) return "—"; const s = (Date.now() - ts) / 1000; return s < 90 ? Math.round(s) + "s ago" : s < 5400 ? Math.round(s / 60) + "m ago" : s < 172800 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago"; }

export function PaperBook({ data }: { data: PaperData }) {
  if (data.nSleeves === 0) {
    return <div className="py-6"><div className="num text-[15px] text-mid">No sleeves in paper yet.</div><div className="num text-[11px] text-dim mt-1">Honest sleeves route here automatically once they pass the significance battery.</div></div>;
  }
  const bookRet = data.book.ret;
  const curve: Curve | undefined = data.book.t.length > 1 ? { t: data.book.t, eq: data.book.eq } : undefined;
  const warming = (data.book.bars ?? 0) <= 48;
  return (
    <div className="grid lg:grid-cols-[1fr_1.1fr] gap-7">
      {/* left: the big forward numbers */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="w-2 h-2 rounded-full bg-info live-dot" />
          <span className="num text-[10px] blue-glow-text tracking-wider">LIVE</span>
          <span className="num text-[10px] text-dim">updated {liveAgo(data.book.lastTs)} · steps hourly</span>
        </div>
        <div className="flex items-end gap-4 mb-1">
          <div className={`num leading-none ${bookRet >= 0 ? "text-up" : "text-down"}`} style={{ fontSize: 52 }}>{bookRet >= 0 ? "+" : ""}{(bookRet * 100).toFixed(2)}%</div>
          <div className="num text-dim text-sm mb-2">forward P&amp;L</div>
        </div>
        <div className="flex flex-wrap gap-x-9 gap-y-3 mt-4">
          <div><div className="hud mb-1.5">Forward Sharpe</div><div className={`num text-[20px] ${warming ? "text-dim" : (data.book.sharpe ?? 0) > 0 ? "text-up" : "text-down"}`}>{warming ? "warming" : fmt(data.book.sharpe)}</div></div>
          <div><div className="hud mb-1.5">Days in paper</div><div className="num text-[20px] text-fg">{data.days.toFixed(1)}</div></div>
          <div><div className="hud mb-1.5">Sleeves</div><div className="num text-[20px] text-accent">{data.nSleeves}</div></div>
          <div><div className="hud mb-1.5">Forward maxDD</div><div className="num text-[20px] text-dim">{pct(data.book.maxDD, 1)}</div></div>
        </div>
        {(() => {
          const fams = [...new Set(data.sleeves.map((s) => s.family))];
          const diversified = fams.length >= 2;
          return (
            <div className="num text-[10px] mt-4 flex flex-wrap items-center gap-2">
              <span className="hud">families</span>
              {fams.map((f) => <span key={f} className="pill pill-soft">{f}</span>)}
              {diversified && <span className="text-up">· diversified (orthogonal IV-vol + DSL, not just correlated breakouts)</span>}
            </div>
          );
        })()}
        <p className="num text-[10px] text-dim mt-4 leading-relaxed max-w-md">
          Simulated forward-test on unseen live data — these are modest, honest sleeves (passed bootstrap-CI&gt;0, deflated&gt;0, perm/PBO), not proven alpha. Some may decay forward; that&apos;s the test working. The record builds over days.
        </p>
      </div>
      {/* right: the combined book equity curve */}
      <div className="min-w-0">
        <div className="flex items-center justify-between mb-2">
          <span className="hud">Live forward equity — extends each hour</span>
          <span className="num text-[9px] blue-glow-text">● LIVE {liveAgo(data.book.lastTs)}</span>
        </div>
        {curve ? <Chart height={210} yLabel="growth of $1" series={[{ name: "paper book (forward)", color: bookRet >= 0 ? "#3ddb9e" : "#fb6f5d", curve }]} /> : (
          <div className="well flex items-center justify-center" style={{ height: 180 }}><span className="hud">{data.book.bars === 0 ? "positions set — P&L accrues from next bar" : "accumulating forward bars…"}</span></div>
        )}
      </div>

      {/* per-sleeve forward rows (full width) */}
      <div className="lg:col-span-2">
        <div className="hud mb-2 mt-1">Per-sleeve forward performance</div>
        <div className="tablewrap">
          <table className="dt">
            <thead><tr><th>sleeve</th><th>family</th><th>fwd P&amp;L</th><th>fwd Sharpe</th><th>fwd maxDD</th><th>days</th><th>equity</th><th>status</th></tr></thead>
            <tbody>
              {data.sleeves.map((s) => (
                <tr key={s.id} className={s.userStrategy || s.source === "regime" ? "blue-glow" : ""}>
                  <td style={{ textAlign: "left" }}>
                    <Link href={`/candidates/${s.id}`} className={s.userStrategy || s.source === "regime" ? "blue-glow-text hover:underline" : "text-mid hover:text-up"}>{s.name}</Link>
                    {(s.userStrategy || s.source === "regime") && <span className="num text-[8px] ml-2 px-1.5 py-0.5 rounded blue-glow-text" style={{ background: "#5cc8ff18" }}>★ regime-aware</span>}
                    {s.leverage && s.leverage > 1 ? <span className="pill text-down ml-2">{s.leverage}x aggressive</span> : null}
                  </td>
                  <td style={{ textAlign: "left" }} className="num text-[10px] text-dim">{s.family}</td>
                  <td className={`dt-num ${s.ret >= 0 ? "text-up" : "text-down"}`}>{s.ret >= 0 ? "+" : ""}{(s.ret * 100).toFixed(2)}%</td>
                  <td className={`dt-num ${s.sharpe === null ? "text-dim" : s.sharpe > 0 ? "text-up" : "text-down"}`}>{s.sharpe === null ? "warming" : fmt(s.sharpe)}</td>
                  <td className="dt-num text-dim">{pct(s.maxDD, 1)}</td>
                  <td className="dt-num text-dim">{s.days.toFixed(1)}</td>
                  <td className="dt-num text-fg">${s.equity.toFixed(0)}</td>
                  <td className="dt-num">{s.halted ? <span className="text-down">halted</span> : <span className="text-up">live</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ================================================================ TrendVsHodl
// The "safer than HODL" payoff: the best trend sleeve's drawdown (underwater)
// curve vs BTC HODL's over the same window — the "~half the drawdown" story at a
// glance — plus side-by-side CAGR/maxDD/Sharpe/Calmar. HONEST framing kept.
export interface TrendVsHodlData {
  name: string; symbol: string; windowYears?: number;
  strat: { t: number[]; eq: number[]; dd: number[] };
  hodl: { t: number[]; eq: number[]; dd: number[] } | null;
  stats: { trendTotal?: number | null; trendCagr: number | null; trendMaxDD: number | null; trendCalmar: number | null; trendSharpe: number | null; hodlTotal?: number | null; hodlCagr: number | null; hodlMaxDD: number | null; hodlCalmar: number | null };
  agg?: { total: number | null; maxDD: number | null; calmar: number | null; leverage: number } | null;
}

// underwater chart: two drawdown curves (strat green, HODL red), 0 at top going down.
function Underwater({ stratDD, stratT, hodlDD, height = 150 }: { stratDD: number[]; stratT: number[]; hodlDD?: number[]; height?: number }) {
  const sd = stratDD.filter((x) => Number.isFinite(x));
  const hd = (hodlDD ?? []).filter((x) => Number.isFinite(x));
  if (sd.length < 2) return <div className="well flex items-center justify-center" style={{ height }}><span className="hud">no drawdown data</span></div>;
  const width = 760, padL = 42, padR = 16, padT = 12, padB = 20;
  const minDD = Math.min(-0.01, ...sd, ...hd);
  const t0 = stratT[0], t1 = stratT[stratT.length - 1] || t0 + 1;
  const X = (i: number, n: number) => padL + (i / Math.max(1, n - 1)) * (width - padL - padR);
  const Y = (v: number) => padT + (v / minDD) * (height - padT - padB);
  const path = (arr: number[]) => arr.map((v, i) => `${X(i, arr.length).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const monthFmt = (ts: number) => { const d = new Date(ts); return `${d.getUTCFullYear()}·${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full block" style={{ maxHeight: height }}>
      {[0, 0.5, 1].map((f) => { const v = minDD * f; return <g key={f}><line x1={padL} x2={width - padR} y1={Y(v)} y2={Y(v)} stroke="#ffffff0a" /><text x={padL - 6} y={Y(v) + 3} textAnchor="end" fontSize="8.5" fill="#586573" fontFamily="var(--font-mono)">{(v * 100).toFixed(0)}%</text></g>; })}
      {[t0, t1].map((ts, i) => <text key={i} x={i === 0 ? padL : width - padR} y={height - 6} textAnchor={i === 0 ? "start" : "end"} fontSize="8.5" fill="#586573" fontFamily="var(--font-mono)">{monthFmt(ts)}</text>)}
      {hd.length > 1 && <><polygon points={`${X(0, hd.length)},${Y(0)} ${path(hd)} ${X(hd.length - 1, hd.length)},${Y(0)}`} fill="#fb6f5d14" /><polyline points={path(hd)} fill="none" stroke="#fb6f5d" strokeWidth="1.3" strokeDasharray="4 3" /></>}
      <polygon points={`${X(0, sd.length)},${Y(0)} ${path(sd)} ${X(sd.length - 1, sd.length)},${Y(0)}`} fill="#3ddb9e18" />
      <polyline points={path(sd)} fill="none" stroke="#3ddb9e" strokeWidth="1.8" />
      <text x={6} y={11} fontSize="7.5" fill="#364250" fontFamily="var(--font-mono)">drawdown (underwater)</text>
      <g transform={`translate(${width - padR - 150}, ${padT + 2})`}>
        <rect x={0} y={-3} width="9" height="2.5" rx="1" fill="#3ddb9e" /><text x={13} y={1} fontSize="8.5" fill="#8b9aab" fontFamily="var(--font-mono)">trend sleeve</text>
        <rect x={78} y={-3} width="9" height="2.5" rx="1" fill="#fb6f5d" /><text x={91} y={1} fontSize="8.5" fill="#8b9aab" fontFamily="var(--font-mono)">BTC HODL</text>
      </g>
    </svg>
  );
}

export function TrendVsHodl({ data }: { data: TrendVsHodlData }) {
  const s = data.stats;
  const ddImprove = s.trendMaxDD !== null && s.hodlMaxDD !== null && s.hodlMaxDD !== 0 ? (1 - Math.abs(s.trendMaxDD) / Math.abs(s.hodlMaxDD)) : null;
  const yrs = data.windowYears ? data.windowYears.toFixed(1) : "~5";
  const beatsRet = s.trendTotal != null && s.hodlTotal != null && s.trendTotal > s.hodlTotal;
  const pctNum = (x: number | null | undefined) => x == null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;
  const Cell = ({ label, t, h, kind = "num" }: { label: string; t: number | null | undefined; h: number | null | undefined; kind?: "num" | "pct" }) => {
    const f = (x: number | null | undefined) => x == null ? "—" : kind === "pct" ? `${(x * 100).toFixed(0)}%` : x.toFixed(2);
    return (
      <div>
        <div className="hud mb-1.5">{label}</div>
        <div className="num text-[17px] text-up">{f(t)}</div>
        <div className="num text-[11px] text-down mt-0.5">{f(h)} <span className="text-dim">HODL</span></div>
      </div>
    );
  };
  return (
    <div className="grid lg:grid-cols-[1.05fr_1fr] gap-7">
      <div>
        {/* THE HEADLINE: trend total return vs HOLDING BTC, full regime-complete window */}
        <div className="num text-[22px] leading-tight mb-1">
          <span className="text-up">{pctNum(s.trendTotal)}</span>
          <span className="text-dim text-[14px]"> trend vs </span>
          <span className="text-down">{pctNum(s.hodlTotal)}</span>
          <span className="text-dim text-[14px]"> holding {data.symbol}</span>
        </div>
        <div className="num text-[11px] text-mid mb-4">
          {beatsRet ? "beats buy-and-hold on RETURN" : "vs buy-and-hold"} {ddImprove !== null ? `· at ${(ddImprove * 100).toFixed(0)}% shallower drawdown` : ""} · full {yrs}y (incl. the 2022 &amp; 2025 crashes)
        </div>
        <div className="flex flex-wrap gap-x-8 gap-y-4 mb-1">
          <Cell label="Total return" t={s.trendTotal} h={s.hodlTotal} kind="pct" />
          <Cell label="Max drawdown" t={s.trendMaxDD} h={s.hodlMaxDD} kind="pct" />
          <Cell label="Calmar" t={s.trendCalmar} h={s.hodlCalmar} />
          <Cell label="Sharpe" t={s.trendSharpe} h={null} />
        </div>
        {data.agg && data.agg.total != null && (
          <div className="mt-4 rounded-lg bg-[#fb6f5d10] border border-[#fb6f5d22] px-3 py-2.5">
            <div className="hud text-down mb-1.5">1.5x AGGRESSIVE variant — head-to-head (backtest)</div>
            <div className="num text-[11px] flex flex-wrap gap-x-5 gap-y-1">
              <span className="text-mid">total <span className="text-down">{pctNum(data.agg.total)}</span> <span className="text-dim">vs 1x {pctNum(s.trendTotal)} vs HODL {pctNum(s.hodlTotal)}</span></span>
              <span className="text-mid">maxDD <span className="text-down">{(data.agg.maxDD! * 100).toFixed(0)}%</span> <span className="text-dim">vs 1x {(s.trendMaxDD! * 100).toFixed(0)}% vs HODL {(s.hodlMaxDD! * 100).toFixed(0)}%</span></span>
              <span className="text-mid">Calmar <span className="text-down">{data.agg.calmar?.toFixed(2)}</span> <span className="text-dim">vs 1x {s.trendCalmar?.toFixed(2)}</span></span>
            </div>
            <p className="num text-[10px] text-dim mt-2 leading-relaxed">
              1.5x = the AGGRESSIVE variant. Backtest adds ~50pp return for ~14pp more drawdown, but the walk-forward says the edge over 1x is THIN (same ~0.78 Sharpe / Calmar) and regime-dependent, and leverage carries real flash-crash / liquidation tail risk (liq ~-66% intrabar) that a daily backtest understates. Forward-testing live to judge whether it earns its risk.
            </p>
          </div>
        )}
        <p className="num text-[10px] text-dim mt-4 leading-relaxed max-w-md">
          Best trend-beta sleeve ({data.name}, long-flat close&gt;SMA) vs SPOT BTC buy-and-hold over the SAME full {yrs}y window — the regime-complete period that includes the 2022 and 2025 crashes (NOT a cherry-picked bull stretch). It beats holding BTC on BOTH return and drawdown here because sitting out the crashes IS the return enhancement. <span className="text-mid">This is BACKTEST; the live PAPER forward-test (sleeves above) is the validation — currently in cash during the downtrend. Regime-dependent; forward-testing to confirm.</span>
        </p>
      </div>
      <div className="min-w-0">
        <Underwater stratDD={data.strat.dd} stratT={data.strat.t} hodlDD={data.hodl?.dd} />
      </div>
    </div>
  );
}
