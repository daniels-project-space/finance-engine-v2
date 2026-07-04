// Sweep the LIVE 70/30 blend's NUPL buy/sell signals + SMA day levels on full history.
// Vary nuplBuy / nuplSell (buy/sell signals) and smaWin (the "SMA day level") + maWin,
// find a robust middle ground vs the live config. Read-only research — deploys nothing.
// Run on VPS: npx tsx scripts/blend-sweep.ts
import { readFileSync } from "node:fs";
import { buildBlendDaily, backtestBlend, blendMetrics } from "../src/engine/blendsleeve";

const raw = JSON.parse(readFileSync("/root/nupl-spike/btc_full.json", "utf8"));
// btc_full.json = { t, price, mvrv } since 2010. Map into a Bars-shaped object.
const bars: any = { symbol: "BTC/USDT", tf: "1d", t: raw.t, c: raw.price, o: raw.price, h: raw.price, l: raw.price, v: raw.price.map(() => 0), ocMvrv: raw.mvrv };

// LIVE config (from seed-blend.ts)
const LIVE = { symbol: "BTC/USDT", tf: "1d", wOnchain: 0.70, smaWin: 100, nuplBuy: 0.0, nuplSell: 0.60, maWin: 200, dcaCapDays: 90, sellStep: 0.06, belowMaCap: 0.5, cashYieldApy: 0.035 } as any;

const ds = (t: number) => new Date(t).toISOString().slice(0, 10);
// Cache BlendDaily per maWin (NUPL + 200d MA depend on maWin, not on the swept signal/smaWin).
const Scache = new Map<number, any>();
const buildS = (maWin: number) => { if (!Scache.has(maWin)) Scache.set(maWin, buildBlendDaily(bars, maWin)); return Scache.get(maWin); };
const idxFrom = (S: any, year: number) => { const target = Date.UTC(year, 0, 1); for (let i = 0; i < S.t.length; i++) if (S.t[i] >= target) return i; return 0; };

function run(doc: any, sinceYear: number) {
  const S = buildS(doc.maWin);
  const startI = Math.max(Math.max(doc.smaWin, doc.maWin) + 2, idxFrom(S, sinceYear));
  const bt = backtestBlend(doc, S, { startI, endI: S.t.length - 1 });
  return blendMetrics(bt.ret);
}
const fx = (m: any) => `${m.finalMult.toFixed(1)}x  DD ${(m.maxDD * 100).toFixed(0)}%  Calmar ${m.calmar.toFixed(2)}  Sharpe ${m.sharpe.toFixed(2)}  CAGR ${(m.cagr * 100).toFixed(0)}%`;

console.log("=".repeat(104));
console.log(`LIVE 70/30 BLEND — NUPL signal + SMA sweep on btc_full.json (${ds(bars.t[0])} → ${ds(bars.t[bars.t.length - 1])})`);
console.log("=".repeat(104));
console.log(`LIVE config (buy<=${LIVE.nuplBuy}, sell>=${LIVE.nuplSell}, smaWin ${LIVE.smaWin}, maWin ${LIVE.maWin}):`);
console.log(`   since 2020:  ${fx(run(LIVE, 2020))}`);
console.log(`   since 2017:  ${fx(run(LIVE, 2017))}`);
console.log(`   since 2013:  ${fx(run(LIVE, 2013))}`);

// ---- SWEEP buy/sell signals + smaWin (maWin fixed 200) ----
const SMA = [50, 75, 100, 125, 150, 200];
const SELL = [0.50, 0.55, 0.60, 0.65, 0.70];
const BUY = [-0.10, -0.05, 0.0, 0.05];
type Row = { smaWin: number; buy: number; sell: number; m20: any; m17: any };
const rows: Row[] = [];
for (const smaWin of SMA) for (const sell of SELL) for (const buy of BUY) {
  const doc = { ...LIVE, smaWin, nuplBuy: buy, nuplSell: sell };
  rows.push({ smaWin, buy, sell, m20: run(doc, 2020), m17: run(doc, 2017) });
}

// Rank by Calmar since-2020, require robustness: also positive Calmar since-2017.
const robust = rows.filter((r) => r.m17.calmar > 0).sort((a, b) => b.m20.calmar - a.m20.calmar);
console.log("\n" + "-".repeat(104));
console.log("TOP 10 BY RISK-ADJUSTED (Calmar since 2020), that ALSO hold up since 2017:");
console.log("  smaWin  buy   sell  |  since2020: mult   DD   Calmar Sharpe |  since2017: mult  DD   Calmar");
for (const r of robust.slice(0, 10)) {
  const live = r.smaWin === LIVE.smaWin && r.buy === LIVE.nuplBuy && r.sell === LIVE.nuplSell ? " <-LIVE" : "";
  console.log(`   ${String(r.smaWin).padStart(3)}   ${String(r.buy).padStart(5)} ${r.sell.toFixed(2)}  |  ${r.m20.finalMult.toFixed(1).padStart(5)}x ${(r.m20.maxDD*100).toFixed(0).padStart(4)}%  ${r.m20.calmar.toFixed(2).padStart(5)} ${r.m20.sharpe.toFixed(2).padStart(5)}  |  ${r.m17.finalMult.toFixed(1).padStart(5)}x ${(r.m17.maxDD*100).toFixed(0).padStart(4)}% ${r.m17.calmar.toFixed(2).padStart(5)}${live}`);
}

// Also: highest RETURN (mult) since 2020, for the "more x" view.
const byMult = rows.slice().sort((a, b) => b.m20.finalMult - a.m20.finalMult);
console.log("\nTOP 6 BY RAW RETURN (mult since 2020):");
for (const r of byMult.slice(0, 6))
  console.log(`   smaWin ${String(r.smaWin).padStart(3)} buy ${String(r.buy).padStart(5)} sell ${r.sell.toFixed(2)}  ->  ${r.m20.finalMult.toFixed(1)}x  DD ${(r.m20.maxDD*100).toFixed(0)}%  Calmar ${r.m20.calmar.toFixed(2)}`);

// ---- The user's core ask: SMA-day middle ground. Hold best buy/sell, sweep smaWin. ----
const best = robust[0];
console.log("\n" + "-".repeat(104));
console.log(`SMA-DAY MIDDLE GROUND — buy<=${best.buy}, sell>=${best.sell} fixed, sweep smaWin (since 2020 || since 2017):`);
console.log("   smaWin |  mult    DD    Calmar  Sharpe  ||  s2017 mult  DD   Calmar");
for (const smaWin of [30, 50, 75, 100, 125, 150, 200, 250]) {
  const doc = { ...LIVE, smaWin, nuplBuy: best.buy, nuplSell: best.sell };
  const a = run(doc, 2020), b = run(doc, 2017);
  const star = smaWin === best.smaWin ? " <-best" : smaWin === LIVE.smaWin ? " (live sma)" : "";
  console.log(`   ${String(smaWin).padStart(4)}   |  ${a.finalMult.toFixed(1).padStart(5)}x ${(a.maxDD*100).toFixed(0).padStart(4)}%  ${a.calmar.toFixed(2).padStart(5)} ${a.sharpe.toFixed(2).padStart(6)}  ||  ${b.finalMult.toFixed(1).padStart(5)}x ${(b.maxDD*100).toFixed(0).padStart(4)}% ${b.calmar.toFixed(2).padStart(5)}${star}`);
}
console.log("=".repeat(104));
