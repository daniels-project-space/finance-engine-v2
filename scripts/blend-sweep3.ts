// Tweak the REMAINING blend params on top of the smaWin125/sell0.60 base:
// wOnchain (the 70/30 split), maWin (2nd SMA), belowMaCap, sellStep, dcaCapDays, cashYieldApy.
// One-at-a-time sensitivity + joint sweep. Both 2020 & 2017 windows (catch overfit). Read-only.
import { readFileSync } from "node:fs";
import { buildBlendDaily, backtestBlend, blendMetrics } from "../src/engine/blendsleeve";

const raw = JSON.parse(readFileSync("/root/nupl-spike/btc_full.json", "utf8"));
const bars: any = { symbol: "BTC/USDT", tf: "1d", t: raw.t, c: raw.price, o: raw.price, h: raw.price, l: raw.price, v: raw.price.map(() => 0), ocMvrv: raw.mvrv };

// BASE = live + the one robust win (smaWin 100->125).
const BASE = { symbol: "BTC/USDT", tf: "1d", wOnchain: 0.70, smaWin: 125, nuplBuy: 0.0, nuplSell: 0.60, maWin: 200, dcaCapDays: 90, sellStep: 0.06, belowMaCap: 0.5, cashYieldApy: 0.035 } as any;
const LIVE = { ...BASE, smaWin: 100 };

const Scache = new Map<number, any>();
const buildS = (maWin: number) => { if (!Scache.has(maWin)) Scache.set(maWin, buildBlendDaily(bars, maWin)); return Scache.get(maWin); };
const idxFrom = (S: any, year: number) => { const tgt = Date.UTC(year, 0, 1); for (let i = 0; i < S.t.length; i++) if (S.t[i] >= tgt) return i; return 0; };
function run(doc: any, year: number) {
  const S = buildS(doc.maWin);
  const startI = Math.max(Math.max(doc.smaWin, doc.maWin) + 2, idxFrom(S, year));
  return blendMetrics(backtestBlend(doc, S, { startI, endI: S.t.length - 1 }).ret);
}
const line = (label: string, doc: any, mark = "") => {
  const a = run(doc, 2020), b = run(doc, 2017);
  console.log(`   ${label.padEnd(14)}|  ${a.finalMult.toFixed(1).padStart(5)}x ${(a.maxDD*100).toFixed(0).padStart(4)}%  C${a.calmar.toFixed(2).padStart(5)} S${a.sharpe.toFixed(2).padStart(5)}  ||  ${b.finalMult.toFixed(1).padStart(6)}x ${(b.maxDD*100).toFixed(0).padStart(4)}%  C${b.calmar.toFixed(2).padStart(5)}${mark}`);
};

console.log("=".repeat(104));
console.log("REMAINING-PARAM SWEEP — base = smaWin125, buy0.0, sell0.60. (since 2020  ||  since 2017)");
console.log("=".repeat(104));
line("LIVE(sma100)", LIVE);
line("BASE(sma125)", BASE, "  <- our base");

console.log("\n-- wOnchain (the 70/30 split; 1.0 = pure on-chain, 0 = pure trend) --");
for (const v of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) line(`wOnchain ${v}`, { ...BASE, wOnchain: v }, v === 0.7 ? " (base)" : "");

console.log("\n-- maWin (the 2nd SMA: trend-confirm / accumulation gate) --");
for (const v of [100, 150, 200, 250, 300]) line(`maWin ${v}`, { ...BASE, maWin: v }, v === 200 ? " (base)" : "");

console.log("\n-- belowMaCap (accumulate this fraction below the 200d MA; 1.0 = off) --");
for (const v of [0.3, 0.4, 0.5, 0.7, 1.0]) line(`belowMaCap ${v}`, { ...BASE, belowMaCap: v }, v === 0.5 ? " (base)" : "");

console.log("\n-- sellStep (DCA-OUT speed into euphoria, per day) --");
for (const v of [0.03, 0.04, 0.06, 0.08, 0.12, 0.20]) line(`sellStep ${v}`, { ...BASE, sellStep: v }, v === 0.06 ? " (base)" : "");

console.log("\n-- dcaCapDays (DCA-IN ramp speed; lower = faster in) --");
for (const v of [30, 60, 90, 120, 180]) line(`dcaCapDays ${v}`, { ...BASE, dcaCapDays: v }, v === 90 ? " (base)" : "");

console.log("\n-- cashYieldApy (idle-cash yield assumption) --");
for (const v of [0.0, 0.02, 0.035, 0.05]) line(`cashYield ${v}`, { ...BASE, cashYieldApy: v }, v === 0.035 ? " (base)" : "");

// ---- JOINT sweep over the 4 real levers; gate on robustness (both windows). ----
type R = { d: any; m20: any; m17: any };
const out: R[] = [];
for (const wOnchain of [0.5, 0.6, 0.7, 0.8, 0.9])
  for (const maWin of [150, 200, 250])
    for (const belowMaCap of [0.3, 0.5, 0.7, 1.0])
      for (const sellStep of [0.04, 0.06, 0.10]) {
        const d = { ...BASE, wOnchain, maWin, belowMaCap, sellStep };
        out.push({ d, m20: run(d, 2020), m17: run(d, 2017) });
      }
// robust = decent on BOTH windows: since-2017 DD not blown out (> -35%) and Calmar2017 > base-ish.
const robust = out.filter((r) => r.m17.maxDD > -0.35).sort((a, b) => (b.m20.calmar + b.m17.calmar) - (a.m20.calmar + a.m17.calmar));
console.log("\n" + "-".repeat(104));
console.log("TOP 12 JOINT COMBOS (ranked by Calmar2020+Calmar2017, gated DD2017 > -35%):");
console.log("  wOnch maWin bCap sStep |  s2020: mult  DD   Calmar |  s2017: mult   DD   Calmar");
for (const r of robust.slice(0, 12)) {
  const d = r.d;
  console.log(`   ${d.wOnchain.toFixed(1)}   ${String(d.maWin).padStart(3)}  ${d.belowMaCap.toFixed(1)} ${d.sellStep.toFixed(2)}  |  ${r.m20.finalMult.toFixed(1).padStart(5)}x ${(r.m20.maxDD*100).toFixed(0).padStart(4)}% ${r.m20.calmar.toFixed(2).padStart(5)}  |  ${r.m17.finalMult.toFixed(1).padStart(6)}x ${(r.m17.maxDD*100).toFixed(0).padStart(4)}% ${r.m17.calmar.toFixed(2).padStart(5)}`);
}
console.log("=".repeat(104));
