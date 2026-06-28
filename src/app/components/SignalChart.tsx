"use client";

// Live signal chart for the Watch tab. Renders, with TradingView's lightweight-charts:
//   • a daily candlestick chart of the asset the strategy trades, with its moving-
//     average overlays (the trend confirms),
//   • a ▲/▼ marker at the exact bar of every paper trade, captioned with the remark
//     (why it fired),
//   • one synced sub-pane per indicator the strategy decides on (e.g. NUPL), each
//     drawn with the EXACT buy/sell trigger lines, plus the target-exposure ramp.
// All panes share one time axis (pan/zoom moves them together). Pure client-side;
// the chart library is imported lazily so it never runs during SSR.

import { useEffect, useRef } from "react";
import type { UTCTimestamp } from "lightweight-charts";
import type { StrategyIndicators } from "../../engine/indicators";

const UP = "#3ddb9e", DOWN = "#fb6f5d", GRID = "rgba(255,255,255,0.04)", AXIS = "rgba(255,255,255,0.08)", TEXT = "#586573";

export type TradeMarker = { ts: number; buy: boolean; reason: string };

export function SignalChart({ data, markers, height = 360 }: {
  data: StrategyIndicators | null;
  markers: TradeMarker[];
  height?: number;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // rebuild only when the actual content changes (not on every reactive equity tick)
  const key = data ? `${data.asOf}|${data.candles.length}|${data.panes.length}|${markers.length}` : "none";

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !data || data.candles.length < 2) return;
    let disposed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const charts: any[] = [];
    let ro: ResizeObserver | null = null;

    (async () => {
      const LWC = await import("lightweight-charts");
      if (disposed || !wrapRef.current) return;
      const { createChart, ColorType, LineStyle, CrosshairMode } = LWC;
      wrap.innerHTML = "";

      const baseOpts = (h: number) => ({
        width: wrap.clientWidth, height: h,
        layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: TEXT, fontSize: 10, fontFamily: "var(--font-mono), ui-monospace, monospace" },
        grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
        rightPriceScale: { borderColor: AXIS, scaleMargins: { top: 0.12, bottom: 0.12 } },
        timeScale: { borderColor: AXIS, timeVisible: false, secondsVisible: false, rightOffset: 3, fixLeftEdge: true },
        crosshair: { mode: CrosshairMode.Normal, vertLine: { color: AXIS, labelBackgroundColor: "#1b2530" }, horzLine: { color: AXIS, labelBackgroundColor: "#1b2530" } },
        handleScale: { axisPressedMouseMove: true }, autoSize: false,
      });

      const toSec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
      const dedupe = <T extends { time: number }>(arr: T[]): T[] => {
        const out: T[] = []; let last = -1;
        for (const p of arr.sort((a, b) => a.time - b.time)) { if (p.time !== last) { out.push(p); last = p.time; } }
        return out;
      };

      // ---- price pane: candles + MA/SMA overlays + trade markers ----
      const priceEl = document.createElement("div");
      wrap.appendChild(priceEl);
      const priceChart = createChart(priceEl, baseOpts(height));
      charts.push(priceChart);
      const candle = priceChart.addCandlestickSeries({ upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false, priceLineVisible: false });
      candle.setData(dedupe(data.candles.map((c) => ({ time: toSec(c.t), open: c.o, high: c.h, low: c.l, close: c.c }))));
      for (const ov of data.overlays) {
        const ls = priceChart.addLineSeries({ color: ov.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        ls.setData(dedupe(ov.series.map((p) => ({ time: toSec(p.t), value: p.v }))));
      }
      if (markers.length) {
        candle.setMarkers(
          dedupe(markers.map((m) => ({
            time: toSec(m.ts), position: m.buy ? "belowBar" : "aboveBar",
            color: m.buy ? UP : DOWN, shape: m.buy ? "arrowUp" : "arrowDown",
            text: (m.buy ? "BUY " : "SELL ") + m.reason,
          })) as never[])
        );
      }

      // ---- indicator sub-panes: line (or 0..1 area) + exact trigger lines ----
      for (const pane of data.panes) {
        const el = document.createElement("div");
        el.style.marginTop = "2px";
        wrap.appendChild(el);
        const c = createChart(el, baseOpts(118));
        charts.push(c);
        // tiny label inside the pane
        const tag = document.createElement("div");
        tag.textContent = pane.label;
        tag.style.cssText = "position:absolute;z-index:3;left:8px;top:4px;font:600 9px var(--font-mono),monospace;color:#7c8a99;letter-spacing:.04em;text-transform:uppercase;pointer-events:none";
        el.style.position = "relative";
        el.appendChild(tag);
        if (pane.fill01) {
          const a = c.addAreaSeries({ lineColor: "#5cc8ff", topColor: "rgba(92,200,255,0.28)", bottomColor: "rgba(92,200,255,0.02)", lineWidth: 2, priceLineVisible: false, lastValueVisible: true, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 1 } }) });
          a.setData(dedupe(pane.series.map((p) => ({ time: toSec(p.t), value: p.v }))));
        } else {
          const ls = c.addLineSeries({ color: "#cbd5e1", lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
          ls.setData(dedupe(pane.series.map((p) => ({ time: toSec(p.t), value: p.v }))));
          for (const th of pane.thresholds) {
            ls.createPriceLine({ price: th.value, color: th.kind === "buy" ? UP : th.kind === "sell" ? DOWN : TEXT, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: th.label });
          }
        }
      }

      // ---- sync all time scales (pan/zoom move together) ----
      let syncing = false;
      for (const src of charts) {
        src.timeScale().subscribeVisibleLogicalRangeChange((range: unknown) => {
          if (syncing || !range) return;
          syncing = true;
          for (const c of charts) if (c !== src) c.timeScale().setVisibleLogicalRange(range);
          syncing = false;
        });
      }
      // fit the most recent ~9 months by default for a readable view
      const n = data.candles.length;
      priceChart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 270), to: n + 3 });

      ro = new ResizeObserver(() => { const w = wrap.clientWidth; for (const c of charts) c.applyOptions({ width: w }); });
      ro.observe(wrap);
    })();

    return () => {
      disposed = true;
      if (ro) ro.disconnect();
      for (const c of charts) { try { c.remove(); } catch { /* */ } }
      if (wrapRef.current) wrapRef.current.innerHTML = "";
    };
  }, [key, height]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data || data.candles.length < 2) {
    return <div className="well flex items-center justify-center" style={{ height }}><span className="hud">indicator chart builds on the next indicators step…</span></div>;
  }
  return <div ref={wrapRef} className="w-full" />;
}
