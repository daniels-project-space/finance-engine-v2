"use client";

// ================================================================ WATCH
// Live paper-trading terminal for the smart-exit blend. A streaming BTC candle
// chart (1m, the right-most bar moves every couple seconds) on the left, and a
// live trade log on the right that fills in the moment the strategy acts. Reactive:
// the log + equity update automatically when the hourly paper step runs. The price
// stream is the OKX public feed via /api/livestream. Read-only, honest.

import { useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import { Lead, Panel, pct, type Curve } from "../components/ds";
import { Chart } from "../components/ds";

type Candle = { t: number; o: number; h: number; l: number; c: number };
const UP = "#3ddb9e", DOWN = "#fb6f5d", INFO = "#5cc8ff", DIM = "#586573";
const usd = (n: number, d = 0) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const hm = (ts: number) => { const d = new Date(ts); return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
const dmy = (ts: number) => { const d = new Date(ts); return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`; };

// poll the live 1-minute candle stream
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

// ---------------------------------------------------------------- candlesticks
function LiveCandles({ candles, last, markers, height = 380 }: {
  candles: Candle[]; last: number | null; markers: { ts: number; buy: boolean }[]; height?: number;
}) {
  const cs = candles.filter((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite));
  if (cs.length < 2) return <div className="well flex items-center justify-center" style={{ height }}><span className="hud">connecting to the live feed…</span></div>;
  const W = 860, padL = 6, padR = 70, padT = 14, padB = 22;
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
      {/* candles */}
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
      {/* trade markers inside the visible window */}
      {markers.filter((m) => m.ts >= t0 - step * 60_000 && m.ts <= t1 + 60_000).map((m, i) => {
        const x = xOfTs(m.ts), y = m.buy ? height - padB - 2 : padT + 2, col = m.buy ? UP : DOWN;
        const tri = m.buy ? `${x},${y - 7} ${x - 5},${y} ${x + 5},${y}` : `${x},${y + 7} ${x - 5},${y} ${x + 5},${y}`;
        return (
          <g key={`m${i}`}>
            <line x1={x} x2={x} y1={padT} y2={height - padB} stroke={col} strokeWidth="0.7" strokeDasharray="2 3" opacity={0.5} />
            <polygon points={tri} fill={col} />
          </g>
        );
      })}
      {/* live price line + tag */}
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

// ---------------------------------------------------------------- trade log row
function TradeRow({ tr }: { tr: { ts: number; weightFrom: number; weightTo: number; price: number; costUsd: number; note?: string } }) {
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
      <div className="shrink-0 num text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ color: col, background: col + "1a" }}>{label}</div>
      <div className="min-w-0 flex-1 num text-[11px] leading-tight">
        <div className="text-fg">{pct(tr.weightFrom, 0)} → <span style={{ color: col }}>{pct(tr.weightTo, 0)}</span></div>
        <div className="text-dim text-[10px] mt-0.5">@ {usd(tr.price)} · {usd(Math.abs(tr.costUsd), 2)} cost</div>
      </div>
    </div>
  );
}

type Mc = { n: number; blockMean: number; finalP5: number; finalP50: number; finalP95: number; ddP5: number; ddP50: number; ddP95: number; pLoss: number; pDD40: number; pDD50: number; histFinal: number; histDD: number };

function McPanel({ mc }: { mc: Mc }) {
  const ddCol = (v: number) => (v > -0.35 ? UP : v > -0.5 ? "#f5b932" : DOWN);
  return (
    <Panel title={<span>Monte Carlo stress test <span className="text-faint">— {mc.n.toLocaleString()} resampled histories</span></span>}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-px rounded-lg overflow-hidden border border-edge/60 bg-edge/30">
        <div className="bg-ink p-4">
          <div className="hud mb-2">worst drawdown</div>
          <div className="num text-[22px] leading-none" style={{ color: ddCol(mc.ddP5) }}>{pct(mc.ddP5, 0)}</div>
          <div className="num text-[9px] text-dim mt-1.5">1-in-20 bad case</div>
          <div className="num text-[10px] text-mid mt-2.5">median {pct(mc.ddP50, 0)} · mild {pct(mc.ddP95, 0)}</div>
          <div className="num text-[9px] text-faint mt-1">historical {pct(mc.histDD, 0)}</div>
        </div>
        <div className="bg-ink p-4">
          <div className="hud mb-2">terminal · growth of $1</div>
          <div className="num text-[22px] leading-none text-fg">{mc.finalP50.toFixed(1)}×</div>
          <div className="num text-[9px] text-dim mt-1.5">median outcome</div>
          <div className="num text-[10px] text-mid mt-2.5">p5 {mc.finalP5.toFixed(1)}× · p95 {mc.finalP95.toFixed(1)}×</div>
          <div className="num text-[9px] text-faint mt-1">historical {mc.histFinal.toFixed(1)}×</div>
        </div>
        <div className="bg-ink p-4">
          <div className="hud mb-2">tail risk</div>
          <div className="num text-[22px] leading-none" style={{ color: mc.pLoss < 0.05 ? UP : "#f5b932" }}>{pct(mc.pLoss, 1)}</div>
          <div className="num text-[9px] text-dim mt-1.5">chance of a net loss</div>
          <div className="num text-[10px] text-mid mt-2.5">DD &lt; −40%: {pct(mc.pDD40, 1)}</div>
          <div className="num text-[10px] text-mid mt-1">DD &lt; −50%: {pct(mc.pDD50, 1)}</div>
        </div>
      </div>
      <div className="num text-[10px] text-dim leading-relaxed mt-3">
        The historical −{Math.abs(mc.histDD * 100).toFixed(0)}% is one draw of luck. Resampling the daily returns in blocks (keeping momentum and volatility clustering) across {mc.n.toLocaleString()} alternate histories, the drawdown stays shallower than {pct(mc.ddP5, 0)} about 95% of the time, and a net loss over the full run happens in {pct(mc.pLoss, 1)} of them. Honest limit: the bootstrap can’t invent a regime worse than anything in 2020–2025, so this is a <span className="text-mid">floor</span> on tail risk, not a ceiling.
      </div>
    </Panel>
  );
}

export default function WatchPage() {
  const paper = useQuery(api.dashboard.paperBook, {});
  const my = useQuery(api.dashboard.myStrategies, {});
  const mc = ((my?.strategies as { key: string; mc?: Mc }[] | undefined)?.find((s) => s.key === "blend7030")?.mc) as Mc | undefined;
  const blend = paper?.sleeves?.find((s) => s.source === "blend");
  const id = blend?.id as string | undefined;
  const trades = useQuery(api.paper.recentTrades, id ? { candidateId: id as never, limit: 120 } : "skip");
  const snaps = useQuery(api.paper.snapshots, id ? { candidateId: id as never, limit: 1500 } : "skip");
  const positions = useQuery(api.paper.positionsFor, id ? { candidateId: id as never } : "skip");
  const stream = useLiveStream();

  // price flash direction
  const prev = useRef<number | null>(null);
  const [dir, setDir] = useState<0 | 1 | -1>(0);
  useEffect(() => {
    if (stream.last == null) return;
    if (prev.current != null) setDir(stream.last > prev.current ? 1 : stream.last < prev.current ? -1 : 0);
    prev.current = stream.last;
  }, [stream.last]);

  if (paper && !blend) {
    return <div className="py-20 text-center"><div className="text-[18px] text-mid">The blend sleeve isn’t in the paper book yet.</div><div className="num text-[12px] text-dim mt-2">It’s seeded on the next paper step.</div></div>;
  }

  const weight = positions?.[0]?.weight ?? 0;
  const inMarket = Math.abs(weight) > 0.02;
  const equity = blend?.equity ?? 10000;
  const ret = blend?.ret ?? 0;
  const days = blend?.days ?? 0;
  const chron = (snaps ?? []).slice().reverse();
  const eqCurve: Curve | undefined = chron.length > 1 ? { t: chron.map((s) => s.ts), eq: chron.map((s) => s.equity / 10000) } : undefined;
  const markers = (trades ?? []).map((t) => ({ ts: t.ts, buy: t.weightTo > t.weightFrom }));
  const priceCol = dir === 1 ? UP : dir === -1 ? DOWN : "#e2e8f0";

  return (
    <div className="space-y-5">
      <Lead dot="live" tone="fg">
        Watching <span className="blue-glow-text font-semibold">On-chain + trend blend (70/30)</span> trade live on paper —
        the BTC bar streams in real time, every trade lands in the log as it happens.
      </Lead>

      {/* live status strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-px rounded-xl overflow-hidden border border-edge bg-edge/40">
        <div className="bg-ink p-4">
          <div className="hud mb-1.5">BTC price · live</div>
          <div className="num text-[26px] leading-none tabular-nums transition-colors duration-300" style={{ color: priceCol }}>
            {stream.last != null ? usd(stream.last) : "—"}
            <span className="inline-block w-1.5 h-1.5 rounded-full ml-2 align-middle live-dot" style={{ background: priceCol }} />
          </div>
          <div className="num text-[9px] text-dim mt-1.5">OKX · updates every ~2.5s</div>
        </div>
        <div className="bg-ink p-4">
          <div className="hud mb-1.5">position now</div>
          <div className="num text-[20px] leading-none" style={{ color: inMarket ? UP : DIM }}>{inMarket ? `LONG ${pct(weight, 0)}` : "CASH"}</div>
          <div className="num text-[9px] text-dim mt-2">{inMarket ? "in the market" : "waiting for a signal"}</div>
        </div>
        <div className="bg-ink p-4">
          <div className="hud mb-1.5">paper equity</div>
          <div className="num text-[20px] leading-none text-fg">{usd(equity)}</div>
          <div className="num text-[9px] mt-2" style={{ color: ret >= 0 ? UP : DOWN }}>{ret >= 0 ? "+" : ""}{pct(ret, 2)} since start</div>
        </div>
        <div className="bg-ink p-4">
          <div className="hud mb-1.5">trades made</div>
          <div className="num text-[20px] leading-none text-fg">{trades?.length ?? 0}</div>
          <div className="num text-[9px] text-dim mt-2">{days >= 1 ? `${days.toFixed(0)}d` : `${(days * 24).toFixed(0)}h`} forward-testing</div>
        </div>
        <div className="bg-ink p-4 col-span-2 sm:col-span-1">
          <div className="hud mb-1.5">status</div>
          <div className="num text-[14px] leading-tight" style={{ color: blend?.halted ? DOWN : UP }}>{blend?.halted ? "halted" : "live · paper"}</div>
          <div className="num text-[9px] text-dim mt-2">simulated — no real money</div>
        </div>
      </div>

      {/* chart + log */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <Panel title={<span>BTC / USDT · 1-minute · live <span className="text-faint">— green/red triangles mark this strategy’s trades</span></span>}>
            <LiveCandles candles={stream.candles} last={stream.last} markers={markers} />
          </Panel>
          <Panel title="this strategy’s paper equity (its own P&L since it went live)">
            {eqCurve ? (
              <Chart series={[{ name: "blend paper", color: INFO, curve: eqCurve }]} height={150} yLabel="growth of $1" />
            ) : (
              <div className="well flex items-center justify-center" style={{ height: 150 }}>
                <span className="hud">equity line starts once the first paper steps record — it’s flat at $10,000 while in cash</span>
              </div>
            )}
          </Panel>
        </div>

        {/* trade log */}
        <Panel title={<span>trade log <span className="text-faint">— newest first</span></span>} className="lg:max-h-[620px] flex flex-col">
          <div className="overflow-y-auto -mx-1 px-1" style={{ maxHeight: 560 }}>
            {trades === undefined ? (
              <div className="hud py-8 text-center">loading…</div>
            ) : trades.length === 0 ? (
              <div className="py-6 px-1">
                <div className="text-[13px] text-mid leading-relaxed">No trades yet — the strategy is in <span style={{ color: DIM }}>cash</span>.</div>
                <div className="num text-[11px] text-dim leading-relaxed mt-3">
                  It buys only when on-chain valuation is in capitulation <span className="text-faint">(NUPL low)</span> and price reclaims its 200-day average, and it distributes into euphoria. Right now neither buy condition is met, so it holds cash and waits.
                </div>
                <div className="num text-[11px] text-dim leading-relaxed mt-3">Every entry, trim and exit will appear here the moment it acts — with the time, price and size.</div>
              </div>
            ) : (
              trades.map((t) => <TradeRow key={t._id} tr={t} />)
            )}
          </div>
        </Panel>
      </div>

      {mc && <McPanel mc={mc} />}

      <div className="num text-[10px] text-dim text-center pt-1">
        Live forward paper-trade of the smart-exit blend — simulated, no real money. The chart price is the live OKX feed; trades, position and equity come from the engine’s hourly paper step and update automatically.
      </div>
    </div>
  );
}
