"use client";

// ================================================================ WATCH
// Live paper-trading cockpit. For the SELECTED strategy it shows:
//   • the daily price chart with the exact indicators it trades on + the trigger
//     lines + a ▲/▼ at every trade (SignalChart),
//   • a live metric strip under the chart (return / CAGR / win-rate / Sharpe / maxDD /
//     time-in-market) tracked since the strategy went live — 0 at the start, moving
//     with every trade,
//   • its return vs BTC-HODL and the S&P 500 from the same start (ChartWithBenchmarks),
//   • a streaming 1-minute BTC tape (the "live now" view) and the running trade log.
// A picker switches strategies — each renders its OWN indicators/logic. All live data
// is reactive Convex; the 1m tape is the OKX public feed. Read-only, honest.

import { useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Lead, Panel, pct, ChartWithBenchmarks, type Curve } from "../components/ds";
import { SignalChart, type TradeMarker } from "../components/SignalChart";

type Candle = { t: number; o: number; h: number; l: number; c: number };
const UP = "#3ddb9e", DOWN = "#fb6f5d", INFO = "#5cc8ff", DIM = "#586573", AMBER = "#f5b932";
const usd = (n: number, d = 0) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const hm = (ts: number) => { const d = new Date(ts); return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
const dmy = (ts: number) => { const d = new Date(ts); return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`; };
const dur = (days: number) => (days < 1 ? `${(days * 24).toFixed(days * 24 < 10 ? 1 : 0)}h` : `${days.toFixed(days < 10 ? 1 : 0)}d`);

// poll the live 1-minute candle stream (the "live now" tape)
function useLiveStream() {
  const [d, setD] = useState<{ candles: Candle[]; last: number | null; ts: number }>({ candles: [], last: null, ts: 0 });
  useEffect(() => {
    let alive = true;
    const load = () => fetch("/api/livestream").then((r) => r.json()).then((j) => { if (alive && Array.isArray(j.candles)) setD({ candles: j.candles, last: j.last ?? null, ts: j.ts }); }).catch(() => { /* */ });
    load();
    const id = setInterval(load, 2500);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return d;
}

// ---------------------------------------------------------------- live 1m tape (SVG)
function LiveCandles({ candles, last, markers, height = 220 }: {
  candles: Candle[]; last: number | null; markers: { ts: number; buy: boolean }[]; height?: number;
}) {
  const cs = candles.filter((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite));
  if (cs.length < 2) return <div className="well flex items-center justify-center" style={{ height }}><span className="hud">connecting to the live feed…</span></div>;
  const W = 860, padL = 6, padR = 70, padT = 12, padB = 20;
  const plotW = W - padL - padR, plotH = height - padT - padB;
  let lo = Infinity, hi = -Infinity;
  for (const c of cs) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
  if (last) { lo = Math.min(lo, last); hi = Math.max(hi, last); }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 1e-9) hi = lo + 1;
  const padP = (hi - lo) * 0.06; lo -= padP; hi += padP;
  const n = cs.length, step = plotW / n;
  const cx = (i: number) => padL + (i + 0.5) * step;
  const Y = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * plotH;
  const bw = Math.max(1, Math.min(8, step * 0.62));
  const t0 = cs[0].t, t1 = cs[n - 1].t;
  const xOfTs = (ts: number) => { const i = Math.round(((ts - t0) / Math.max(1, t1 - t0)) * (n - 1)); return cx(Math.max(0, Math.min(n - 1, i))); };
  const lastUp = last != null && last >= cs[n - 1].o;
  const yTicks = [lo + (hi - lo) * 0.04, (lo + hi) / 2, hi - (hi - lo) * 0.04];
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full block" style={{ maxHeight: height }} preserveAspectRatio="xMidYMid meet">
      {yTicks.map((p, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={Y(p)} y2={Y(p)} stroke="#ffffff08" strokeWidth="1" />
          <text x={W - padR + 5} y={Y(p) + 3} fontSize="8.5" fill={DIM} fontFamily="var(--font-mono)">{usd(p)}</text>
        </g>
      ))}
      {[t0, (t0 + t1) / 2, t1].map((ts, i) => (
        <text key={i} x={i === 0 ? padL : i === 2 ? W - padR : W / 2 - padR / 2} y={height - 6} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} fontSize="8.5" fill={DIM} fontFamily="var(--font-mono)">{hm(ts)}</text>
      ))}
      {cs.map((c, i) => {
        const up = c.c >= c.o, col = up ? UP : DOWN, x = cx(i);
        const yo = Y(c.o), yc = Y(c.c), bodyTop = Math.min(yo, yc), bodyH = Math.max(1, Math.abs(yc - yo));
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={Y(c.h)} y2={Y(c.l)} stroke={col} strokeWidth="0.8" opacity={0.85} />
            <rect x={x - bw / 2} y={bodyTop} width={bw} height={bodyH} fill={col} opacity={i === n - 1 ? 1 : 0.78} rx={0.5} />
          </g>
        );
      })}
      {markers.filter((m) => m.ts >= t0 - 60_000 && m.ts <= t1 + 60_000).map((m, i) => {
        const x = xOfTs(m.ts), y = m.buy ? height - padB - 2 : padT + 2, col = m.buy ? UP : DOWN;
        const tri = m.buy ? `${x},${y - 7} ${x - 5},${y} ${x + 5},${y}` : `${x},${y + 7} ${x - 5},${y} ${x + 5},${y}`;
        return (
          <g key={`m${i}`}>
            <line x1={x} x2={x} y1={padT} y2={height - padB} stroke={col} strokeWidth="0.7" strokeDasharray="2 3" opacity={0.5} />
            <polygon points={tri} fill={col} />
          </g>
        );
      })}
      {last != null && (
        <g>
          <line x1={padL} x2={W - padR} y1={Y(last)} y2={Y(last)} stroke={lastUp ? UP : DOWN} strokeWidth="1" strokeDasharray="3 3" opacity={0.9} />
          <rect x={W - padR + 1} y={Y(last) - 8} width={padR - 2} height={16} rx={2} fill={lastUp ? UP : DOWN} />
          <text x={W - padR + 6} y={Y(last) + 3.5} fontSize="9.5" fill="#0a0f14" fontFamily="var(--font-mono)" fontWeight="700">{usd(last)}</text>
        </g>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------- metric tile
function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-ink p-3.5">
      <div className="hud mb-1.5">{label}</div>
      <div className="num text-[19px] leading-none" style={{ color: color ?? "#e2e8f0" }}>{value}</div>
      {sub && <div className="num text-[9px] text-dim mt-1.5">{sub}</div>}
    </div>
  );
}

type Metrics = {
  totalReturn: number; cagr: number | null; maxDD: number; sharpe: number | null; winRate: number | null;
  trades: number; closedTrades: number; wins: number; losses: number; daysLive: number; timeInMarket: number; equity: number;
};

function MetricStrip({ m }: { m: Metrics }) {
  const sign = (v: number) => (v >= 0 ? "+" : "");
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-px rounded-xl overflow-hidden border border-edge bg-edge/40">
      <Tile label="return · live" value={`${sign(m.totalReturn)}${pct(m.totalReturn, 2)}`} sub="since it went live" color={m.totalReturn >= 0 ? UP : DOWN} />
      <Tile label="CAGR" value={m.cagr == null ? "—" : `${sign(m.cagr)}${pct(m.cagr, 1)}`} sub={m.cagr == null ? `after 14d (${dur(m.daysLive)})` : "annualized"} color={m.cagr == null ? DIM : m.cagr >= 0 ? UP : DOWN} />
      <Tile label="win rate" value={m.winRate == null ? "—" : pct(m.winRate, 0)} sub={m.closedTrades ? `${m.wins}/${m.closedTrades} closed` : "no closed trades"} color={m.winRate == null ? DIM : m.winRate >= 0.5 ? UP : AMBER} />
      <Tile label="Sharpe · fwd" value={m.sharpe == null ? "—" : m.sharpe.toFixed(2)} sub={m.sharpe == null ? "building…" : "annualized"} color={m.sharpe == null ? DIM : m.sharpe >= 1 ? UP : "#e2e8f0"} />
      <Tile label="max drawdown" value={pct(m.maxDD, 1)} sub="live peak-to-trough" color={m.maxDD > -0.15 ? "#e2e8f0" : m.maxDD > -0.3 ? AMBER : DOWN} />
      <Tile label="trades" value={`${m.trades}`} sub={`${m.closedTrades} round-trips`} />
      <Tile label="time in market" value={pct(m.timeInMarket, 0)} sub="rest in cash" color={INFO} />
      <Tile label="days live" value={dur(m.daysLive)} sub="forward-testing" />
    </div>
  );
}

// ---------------------------------------------------------------- trade log row
function TradeRow({ tr }: { tr: { ts: number; weightFrom: number; weightTo: number; price: number; costUsd: number; reason: string } }) {
  const buy = tr.weightTo > tr.weightFrom;
  const flat = Math.abs(tr.weightTo) < 1e-6;
  const col = flat ? DOWN : buy ? UP : DOWN;
  const label = flat ? "EXIT" : buy ? "BUY" : "TRIM";
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-edge/40 last:border-0">
      <div className="shrink-0 num text-[10px] text-dim leading-tight w-14">
        <div className="text-mid">{hm(tr.ts)}</div>
        <div className="text-faint">{dmy(tr.ts)}</div>
      </div>
      <div className="shrink-0 num text-[10px] font-semibold px-1.5 py-0.5 rounded self-start" style={{ color: col, background: col + "1a" }}>{label}</div>
      <div className="min-w-0 flex-1 num text-[11px] leading-tight">
        <div className="text-fg">{pct(tr.weightFrom, 0)} → <span style={{ color: col }}>{pct(tr.weightTo, 0)}</span> <span className="text-faint">@ {usd(tr.price)}</span></div>
        <div className="text-dim text-[10px] mt-0.5">{tr.reason}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- strategy picker
function StrategyPicker({ list, value, onChange }: {
  list: { id: string; name: string; family: string; symbol: string; primary: boolean }[];
  value: string | undefined; onChange: (id: string) => void;
}) {
  if (!list.length) return null;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="hud">watching</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="num text-[12px] bg-ink border border-edge rounded-lg px-3 py-1.5 text-fg outline-none focus:border-info/60 cursor-pointer"
      >
        {list.map((s) => (
          <option key={s.id} value={s.id}>
            {s.primary ? "★ " : ""}{s.family} · {s.symbol.replace("/USDT", "")} — {s.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function WatchPage() {
  const strategies = useQuery(api.watch.liveStrategies, {});
  const [sel, setSel] = useState<string | undefined>(undefined);
  // default to the starred (BTC 70/30 blend) or the first available strategy
  useEffect(() => {
    if (sel || !strategies?.length) return;
    setSel((strategies.find((s) => s.primary) ?? strategies[0]).id);
  }, [strategies, sel]);

  const state = useQuery(api.watch.liveState, sel ? { candidateId: sel as Id<"candidates"> } : "skip");
  const bench = useQuery(api.dashboard.benchmarks, {});
  const stream = useLiveStream();

  // live price flash direction
  const prev = useRef<number | null>(null);
  const [dir, setDir] = useState<0 | 1 | -1>(0);
  useEffect(() => {
    if (stream.last == null) return;
    if (prev.current != null) setDir(stream.last > prev.current ? 1 : stream.last < prev.current ? -1 : 0);
    prev.current = stream.last;
  }, [stream.last]);

  const markers: TradeMarker[] = useMemo(
    () => (state?.trades ?? []).map((t) => ({ ts: t.ts, buy: t.weightTo > t.weightFrom, reason: t.reason })),
    [state?.trades],
  );
  const tapeMarkers = useMemo(() => (state?.trades ?? []).map((t) => ({ ts: t.ts, buy: t.weightTo > t.weightFrom })), [state?.trades]);
  const eqCurve: Curve | undefined = state && state.equity.t.length > 1 ? { t: state.equity.t, eq: state.equity.eq } : undefined;

  const priceCol = dir === 1 ? UP : dir === -1 ? DOWN : "#e2e8f0";
  const m = state?.metrics;
  const inMarket = state ? Math.abs(state.meta.currentWeight) > 0.02 : false;

  return (
    <div className="space-y-5">
      <Lead dot="live" tone="fg">
        Watching <span className="blue-glow-text font-semibold">{state?.meta.family ?? "your best strategy"}</span> trade live on paper —
        its real indicators, the lines where it fires, every trade marked, and how it stacks up against just holding.
      </Lead>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <StrategyPicker list={strategies ?? []} value={sel} onChange={setSel} />
        <div className="num text-[10px] text-dim">simulated · no real money{state?.meta.indicatorsAsOf ? ` · indicators ${dmy(state.meta.indicatorsAsOf)} ${hm(state.meta.indicatorsAsOf)}` : ""}</div>
      </div>

      {/* live status strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-px rounded-xl overflow-hidden border border-edge bg-edge/40">
        <div className="bg-ink p-4">
          <div className="hud mb-1.5">{(state?.meta.symbol ?? "BTC/USDT").replace("/USDT", "")} price · live</div>
          <div className="num text-[24px] leading-none tabular-nums transition-colors duration-300" style={{ color: priceCol }}>
            {stream.last != null ? usd(stream.last) : "—"}
            <span className="inline-block w-1.5 h-1.5 rounded-full ml-2 align-middle live-dot" style={{ background: priceCol }} />
          </div>
          <div className="num text-[9px] text-dim mt-1.5">OKX · ~2.5s</div>
        </div>
        <div className="bg-ink p-4">
          <div className="hud mb-1.5">position now</div>
          <div className="num text-[18px] leading-none" style={{ color: inMarket ? UP : DIM }}>{inMarket ? `${state!.meta.position} ${pct(state!.meta.currentWeight, 0)}` : "CASH"}</div>
          <div className="num text-[9px] text-dim mt-2">{inMarket ? "in the market" : "waiting for a signal"}</div>
        </div>
        <div className="bg-ink p-4">
          <div className="hud mb-1.5">paper equity</div>
          <div className="num text-[18px] leading-none text-fg">{usd(state?.meta.equity ?? 10000)}</div>
          <div className="num text-[9px] mt-2" style={{ color: (m?.totalReturn ?? 0) >= 0 ? UP : DOWN }}>{(m?.totalReturn ?? 0) >= 0 ? "+" : ""}{pct(m?.totalReturn ?? 0, 2)} since start</div>
        </div>
        <div className="bg-ink p-4">
          <div className="hud mb-1.5">trades made</div>
          <div className="num text-[18px] leading-none text-fg">{m?.trades ?? 0}</div>
          <div className="num text-[9px] text-dim mt-2">{dur(m?.daysLive ?? 0)} forward-testing</div>
        </div>
        <div className="bg-ink p-4 col-span-2 sm:col-span-1">
          <div className="hud mb-1.5">status</div>
          <div className="num text-[14px] leading-tight" style={{ color: state?.meta.halted ? DOWN : UP }}>{state?.meta.halted ? "halted" : "live · paper"}</div>
          <div className="num text-[9px] text-dim mt-2">starts at $10,000</div>
        </div>
      </div>

      {/* signal chart — the indicators + trigger lines + trade marks */}
      <Panel title={
        <span>
          {(state?.meta.symbol ?? "BTC/USDT").replace("/USDT", "")} · daily · the indicators this strategy trades on
          <span className="text-faint"> — ▲ buy / ▼ sell mark each trade; dashed lines are the trigger levels</span>
        </span>
      }>
        <SignalChart data={state?.indicators ?? null} markers={markers} height={380} />
        {state?.meta.logic && <div className="num text-[10.5px] text-dim leading-relaxed mt-3 border-t border-edge/40 pt-3"><span className="text-mid">How it decides:</span> {state.meta.logic}</div>}
      </Panel>

      {/* live metrics — under the chart, 0 at the start, moving with every trade */}
      {m ? <MetricStrip m={m} /> : <div className="well h-20 flex items-center justify-center"><span className="hud">loading live metrics…</span></div>}

      {/* return vs benchmarks + trade log */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <Panel title={<span>return since it went live <span className="text-faint">— this strategy vs holding BTC vs the S&amp;P 500</span></span>}>
            {eqCurve ? (
              <ChartWithBenchmarks
                series={[{ name: "this strategy", color: INFO, curve: eqCurve }]}
                benchmarks={bench ?? null}
                height={230}
                yLabel="growth of $1"
                showMetrics
                stratLabel={state?.meta.family ?? "strategy"}
                ppy={365}
              />
            ) : (
              <div className="well flex items-center justify-center" style={{ height: 230 }}>
                <span className="hud">the curve starts at $1 the moment it goes live — flat while in cash, then it tracks vs BTC-HODL &amp; the S&amp;P 500</span>
              </div>
            )}
          </Panel>
        </div>

        <Panel title={<span>trade log <span className="text-faint">— newest first</span></span>} className="lg:max-h-[560px] flex flex-col">
          <div className="overflow-y-auto -mx-1 px-1" style={{ maxHeight: 500 }}>
            {state === undefined ? (
              <div className="hud py-8 text-center">loading…</div>
            ) : !state || state.trades.length === 0 ? (
              <div className="py-6 px-1">
                <div className="text-[13px] text-mid leading-relaxed">No trades yet — the strategy is in <span style={{ color: DIM }}>cash</span>, waiting for a signal.</div>
                <div className="num text-[11px] text-dim leading-relaxed mt-3">Every entry, trim and exit lands here the instant it fires — with the time, price, size and the reason. The metrics above stay at 0 until then.</div>
              </div>
            ) : (
              state.trades.map((t) => <TradeRow key={t._id} tr={t} />)
            )}
          </div>
        </Panel>
      </div>

      {/* live 1-minute tape */}
      <Panel title={<span>{(state?.meta.symbol ?? "BTC/USDT").replace("/USDT", "")} / USDT · 1-minute · live now <span className="text-faint">— the right-most bar moves in real time</span></span>}>
        <LiveCandles candles={stream.candles} last={stream.last} markers={tapeMarkers} height={220} />
      </Panel>

      <div className="num text-[10px] text-dim text-center pt-1">
        Live forward paper-trade — simulated, no real money. Price tape is the live OKX feed; trades, position, equity and the metric strip come from the engine&apos;s hourly paper step and the daily indicator track, and update automatically. Indicators reflect the latest closed daily bar.
      </div>
    </div>
  );
}
