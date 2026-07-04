// Joint sweep: NUPL buy% x sell% x smaWin. For each SMA, a buy×sell Calmar matrix,
// then the global best combos. Read-only research on btc_full.json. Deploys nothing.
import { readFileSync } from "node:fs";
import { buildBlendDaily, backtestBlend, blendMetrics } from "../src/engine/blendsleeve";

const raw = JSON.parse(readFileSync("/root/nupl-spike/btc_full.json", "utf8"));
const bars: any = { symbol: "BTC/USDT", tf: "1d", t: raw.t, c: raw.price, o: raw.price, h: raw.price, l: raw.price, v: raw.price.map(() => 0), ocMvrv: raw.mvrv };
const LIVE = { symbol: "BTC/USDT", tf: "1d", wOnchain: 0.70, smaWin: 100, nuplBuy: 0.0, nuplSell: 0.60, maWin: 200, dcaCapDays: 90, sellStep: 0.06, belowMaCap: 0.5, cashYieldApy: 0.035 } as any;

const Scache = new Map<number, any>();
const buildS = (maWin: number) => { if (!Scache.has(maWin)) Scache.set(maWin, buildBlendDaily(bars, maWin)); return Scache.get(maWin); };
const idxFrom = (S: any, year: number) => { const tgt = Date.UTC(year, 0, 1); for (let i = 0; i < S.t.length; i++) if (S.t[i] >= tgt) return i; return 0; };
function run(doc: any, year: number) {
  const S = buildS(doc.maWin);
  const startI = Math.max(Math.max(doc.smaWin, doc.maWin) + 2, idxFrom(S, year));
  return blendMetrics(backtestBlend(doc, S, { startI, endI: S.t.length - 1 }).ret);
}

// Grids — buy opened UP into the 0.10-0.25 zone (where it changes accumulation), sell fine around 0.6.
const SMA = [75, 100, 125, 150];
const BUY = [-0.05, 0.0, 0.05, 0.10, 0.15, 0.20, 0.25];
const SELL = [0.50, 0.55, 0.575, 0.60, 0.625, 0.65, 0.70];

type Row = { smaWin: number; buy: number; sell: number; m20: any; m17: any };
const rows: Row[] = [];
for (const smaWin of SMA) for (const buy of BUY) for (const sell of SELL) {
  const doc = { ...LIVE, smaWin, nuplBuy: buy, nuplSell: sell };
  rows.push({ smaWin, buy, sell, m20: run(doc, 2020), m17: run(doc, 2017) });
}

console.log("=".repeat(108));
console.log("NUPL buy% x sell% x smaWin JOINT SWEEP — btc_full.json. Cells = Calmar since 2020 (risk-adjusted).");
const L = run(LIVE, 2020), L17 = run(LIVE, 2017);
console.log(`LIVE (sma100,buy0.0,sell0.60): since2020 ${L.finalMult.toFixed(1)}x DD ${(L.maxDD*100).toFixed(0)}% Calmar ${L.calmar.toFixed(2)} | since2017 ${L17.finalMult.toFixed(1)}x Calmar ${L17.calmar.toFixed(2)}`);
console.log("=".repeat(108));

// Per-SMA buy×sell Calmar matrix.
for (const smaWin of SMA) {
  console.log(`\nsmaWin ${smaWin}   (rows=buy, cols=sell)   Calmar since 2020`);
  console.log("   buy\\sell " + SELL.map((s) => s.toFixed(3).padStart(7)).join(""));
  for (const buy of BUY) {
    const cells = SELL.map((sell) => {
      const r = rows.find((x) => x.smaWin === smaWin && x.buy === buy && x.sell === sell)!;
      return r.m20.calmar.toFixed(2).padStart(7);
    });
    console.log(`   ${String(buy).padStart(6)}  ` + cells.join(""));
  }
}

// Global rankings (robust = positive since-2017 Calmar).
const robust = rows.filter((r) => r.m17.calmar > 0);
console.log("\n" + "-".repeat(108));
console.log("TOP 12 COMBINATIONS BY Calmar (since 2020), must also hold since 2017:");
console.log("  sma  buy   sell  |  s2020: mult   DD   Calmar Sharpe |  s2017: mult   DD   Calmar");
for (const r of robust.slice().sort((a, b) => b.m20.calmar - a.m20.calmar).slice(0, 12)) {
  const live = r.smaWin === 100 && r.buy === 0.0 && r.sell === 0.60 ? " <-LIVE" : "";
  console.log(`  ${String(r.smaWin).padStart(3)} ${String(r.buy).padStart(5)} ${r.sell.toFixed(3)} |  ${r.m20.finalMult.toFixed(1).padStart(5)}x ${(r.m20.maxDD*100).toFixed(0).padStart(4)}% ${r.m20.calmar.toFixed(2).padStart(5)} ${r.m20.sharpe.toFixed(2).padStart(5)}  |  ${r.m17.finalMult.toFixed(1).padStart(5)}x ${(r.m17.maxDD*100).toFixed(0).padStart(4)}% ${r.m17.calmar.toFixed(2).padStart(5)}${live}`);
}
console.log("\nTOP 8 BY RAW RETURN (mult since 2020):");
for (const r of rows.slice().sort((a, b) => b.m20.finalMult - a.m20.finalMult).slice(0, 8))
  console.log(`  sma ${String(r.smaWin).padStart(3)} buy ${String(r.buy).padStart(5)} sell ${r.sell.toFixed(3)} -> ${r.m20.finalMult.toFixed(1)}x DD ${(r.m20.maxDD*100).toFixed(0)}% Calmar ${r.m20.calmar.toFixed(2)} | s2017 ${r.m17.finalMult.toFixed(1)}x DD ${(r.m17.maxDD*100).toFixed(0)}%`);
console.log("=".repeat(108));
