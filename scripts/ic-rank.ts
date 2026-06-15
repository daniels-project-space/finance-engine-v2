// WAVE-3a SIGNAL-IC RANKING over REAL bars. Builds the signal catalog (incl. the
// new crypto-native features) on the universe, pools their IC across symbols over
// the pre-seal dev period, and prints which signals actually predict forward
// returns. SHADOW: persists to Convex only with --persist (never drives anything).
//
// Data source: ingestSymbol() (binance.vision archives + OKX/fapi tails). With R2
// creds in env it reads/writes the candle cache; WITHOUT R2 it backfills fresh
// in-memory so the ranking still runs (set IC_RANK_NO_R2=1 to force in-memory).
//
// Usage:
//   npx tsx scripts/ic-rank.ts                 # all majors, default horizon, print
//   npx tsx scripts/ic-rank.ts --persist       # also upsert the Convex report
//   IC_RANK_SYMBOLS="BTC/USDT,ETH/USDT" npx tsx scripts/ic-rank.ts
//   IC_RANK_HORIZON=24 npx tsx scripts/ic-rank.ts

import { ingestSymbol, loadBars } from "../src/lib/data";
import { buildSignalMatrix, SIGNAL_CATALOG, hasData } from "../src/engine/signals";
import { rankSignalsPooled, type SymbolSignals } from "../src/engine/ic";
import { indexOfTs } from "../src/engine/backtest";
import type { Bars } from "../src/engine/types";

const CRYPTO_NATIVE = new Set([
  "funding", "fundroc", "fundzscore", "fundaccel", "fundmom",
  "basis", "basis_zscore_96", "basis_roc_24", "oi_zscore_168", "oi_roc_24", "lsr_zscore_96",
]);

function sampleVals(a: ArrayLike<number>, k = 3): string {
  const out: number[] = [];
  for (let i = a.length - 1; i >= 0 && out.length < k; i--) if (Number.isFinite(a[i]) && a[i] !== 0) out.unshift(Number(a[i].toPrecision(4)));
  return out.length ? out.join(", ") : "(none)";
}

async function getBars(symbol: string, tf: string, historyStart: number, log: (m: string) => void): Promise<Bars | null> {
  const noR2 = process.env.IC_RANK_NO_R2 === "1" || !process.env.R2_ENDPOINT;
  if (!noR2) {
    try {
      const r = await ingestSymbol(symbol, tf, historyStart, log);
      log(`${symbol}: ${r.bars} bars (+${r.appended}) src=${r.source}`);
      return await loadBars(symbol, tf);
    } catch (e) {
      log(`${symbol}: R2 ingest failed (${e instanceof Error ? e.message.slice(0, 80) : e}) — falling back to in-memory backfill`);
    }
  }
  // in-memory: backfill straight from the public sources without touching R2.
  return backfillInMemory(symbol, tf, historyStart, log);
}

// Mirror of ingestSymbol's fetch logic but returning bars WITHOUT any R2 I/O.
async function backfillInMemory(symbol: string, tf: string, historyStart: number, log: (m: string) => void): Promise<Bars> {
  const { visionKlines, visionFunding, visionSpotKlines, visionMetrics } = await import("../src/lib/vision");
  const now = Date.now();
  const tfMs = tf === "1h" ? 3_600_000 : tf === "4h" ? 14_400_000 : 86_400_000;
  const visionEnd = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1) - 1;
  log(`${symbol}: in-memory backfill ${new Date(historyStart).toISOString().slice(0, 10)}..${new Date(visionEnd).toISOString().slice(0, 10)}`);
  const k = await visionKlines(symbol, tf, historyStart, visionEnd);
  const bars: Bars = { symbol, tf, t: [], o: [], h: [], l: [], c: [], v: [] };
  for (const r of k) { bars.t.push(r.t); bars.o.push(r.o); bars.h.push(r.h); bars.l.push(r.l); bars.c.push(r.c); bars.v.push(r.v); }
  const f = await visionFunding(symbol, historyStart, visionEnd);
  bars.fundingT = f.t; bars.fundingR = f.r;
  // basis: bar-aligned spot close
  const sp = await visionSpotKlines(symbol, tf, historyStart, visionEnd);
  const spotMap = new Map<number, number>(); for (const r of sp) spotMap.set(r.t, r.c);
  bars.spotC = bars.t.map((ts) => spotMap.get(ts) ?? 0);
  // OI + LSR
  const ms = await visionMetrics(symbol, historyStart, visionEnd, log);
  bars.oiT = ms.oiT; bars.oiV = ms.oiV; bars.lsrT = ms.lsrT; bars.lsrR = ms.lsrR;
  return bars;
}

async function main() {
  const persist = process.argv.includes("--persist");
  const tf = process.env.IC_RANK_TF ?? "1h";
  const horizon = Number(process.env.IC_RANK_HORIZON ?? (tf === "1d" ? 5 : tf === "4h" ? 6 : 24));
  const symbols = (process.env.IC_RANK_SYMBOLS ?? "BTC/USDT,ETH/USDT,SOL/USDT,BNB/USDT,XRP/USDT").split(",").map((s) => s.trim());
  const historyStart = Date.parse(process.env.IC_RANK_HISTORY_START ?? "2021-06-01");
  const sealTs = Date.parse(process.env.IC_RANK_SEAL ?? "2026-02-01"); // pre-seal dev period only
  const log = (m: string) => { if (m.includes("OUTLIER") || m.includes("failed") || m.includes("metrics") || m.includes("backfill") || m.includes("bars")) console.log("  ", m); };

  console.log(`\n=== WAVE-3a signal-IC ranking ===`);
  console.log(`universe=${symbols.join(" ")} tf=${tf} horizon=${horizon} dev<${new Date(sealTs).toISOString().slice(0, 10)}\n`);

  // --- real-data proof + per-symbol signal matrices over the DEV period ---
  const perSymbol: SymbolSignals[] = [];
  const proofRows: string[] = [];
  for (const symbol of symbols) {
    const bars = await getBars(symbol, tf, historyStart, log);
    if (!bars || bars.t.length < 500) { console.log(`  ${symbol}: insufficient bars, skipping`); continue; }
    // restrict to pre-seal dev
    const devEnd = indexOfTs(bars.t, sealTs) - 1;
    const dev: Bars = {
      ...bars,
      t: bars.t.slice(0, devEnd + 1), o: bars.o.slice(0, devEnd + 1), h: bars.h.slice(0, devEnd + 1),
      l: bars.l.slice(0, devEnd + 1), c: bars.c.slice(0, devEnd + 1), v: bars.v.slice(0, devEnd + 1),
      spotC: bars.spotC ? bars.spotC.slice(0, devEnd + 1) : undefined,
    };
    const matrix = buildSignalMatrix(dev);
    perSymbol.push({ signals: matrix, closes: dev.c });

    // real-data proof for the NEW crypto-native features
    const spotN = (bars.spotC ?? []).filter((x) => x > 0).length;
    const oiN = bars.oiT?.length ?? 0;
    const lsrN = bars.lsrT?.length ?? 0;
    const span = `${new Date(bars.t[0]).toISOString().slice(0, 10)}..${new Date(bars.t[bars.t.length - 1]).toISOString().slice(0, 10)}`;
    proofRows.push(`  ${symbol.padEnd(9)} bars=${String(bars.t.length).padStart(6)} ${span}  spot=${spotN} fund=${bars.fundingT?.length ?? 0} oi=${oiN} lsr=${lsrN}`);
    const basis = matrix.find((m) => m.name === "basis")!.values;
    const oiz = matrix.find((m) => m.name === "oi_zscore_168")!.values;
    proofRows.push(`           basis sample=[${sampleVals(basis)}]  oi_z sample=[${sampleVals(oiz)}]`);
  }

  console.log(`\n--- real-data proof (crypto-native series ingested) ---`);
  for (const r of proofRows) console.log(r);

  if (perSymbol.length === 0) { console.log("\nno symbols ranked"); process.exit(1); }

  // --- pooled IC ranking ---
  const res = rankSignalsPooled(perSymbol, horizon, { redundancyCorr: 0.85 });
  console.log(`\n--- pooled signal IC ranking (${perSymbol.length} symbols, horizon=${horizon} bars) ---`);
  console.log(`  ${"rank".padEnd(5)}${"signal".padEnd(20)}${"IC-IR".padStart(8)}${"pooledIC".padStart(10)}${"t-stat".padStart(8)}${"N".padStart(9)}  flags`);
  res.ranked.forEach((r, i) => {
    const cn = CRYPTO_NATIVE.has(r.name) ? " *crypto" : "";
    const red = r.redundant ? ` ~redundant(${r.redundantWith})` : "";
    console.log(`  ${String(i + 1).padEnd(5)}${r.name.padEnd(20)}${r.icIR.toFixed(2).padStart(8)}${r.pooledIC.toFixed(3).padStart(10)}${r.tStat.toFixed(1).padStart(8)}${String(r.n).padStart(9)}${cn}${red}`);
  });
  const cryptoTop = res.ranked.filter((r) => CRYPTO_NATIVE.has(r.name)).slice(0, 5).map((r) => `${r.name}(IR=${r.icIR.toFixed(2)})`);
  console.log(`\n  crypto-native signals: ${cryptoTop.join(", ")}`);

  if (persist) {
    const url = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) { console.log("\n--persist set but CONVEX_URL missing — skipping persist"); }
    else {
      const { ConvexHttpClient } = await import("convex/browser");
      const { api } = await import("../convex/_generated/api");
      const cx = new ConvexHttpClient(url);
      await cx.mutation(api.signalIc.upsert, {
        horizon, redundancyCorr: res.redundancyCorr, symbolsPooled: symbols,
        ranked: res.ranked.map((r) => ({
          name: r.name, icMean: r.icMean, icIR: r.icIR, tStat: r.tStat, n: r.n, pooledIC: r.pooledIC,
          maxCorrToBetter: r.maxCorrToBetter, redundantWith: r.redundantWith, redundant: r.redundant,
          cryptoNative: CRYPTO_NATIVE.has(r.name),
        })),
      });
      console.log("\npersisted IC report to Convex (signalIcReports:current)");
    }
  }
  console.log(`\n(catalog: ${SIGNAL_CATALOG.length} signals; SHADOW — never binds promotion)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
