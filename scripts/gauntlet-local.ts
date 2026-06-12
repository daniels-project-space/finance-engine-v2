import { runGauntlet } from "../src/engine/gauntlet";
import { randomStrategy } from "../src/engine/evolve";
import { loadBars } from "../src/lib/data";
import { DEFAULT_FLOORS, type Bars } from "../src/engine/types";

async function main() {
  const primary = await loadBars("BTC/USDT", "1h");
  const others: Bars[] = [];
  for (const s of ["ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT"]) {
    const b = await loadBars(s, "1h"); if (b) others.push(b);
  }
  const b4h = await loadBars("BTC/USDT", "4h"); if (b4h) others.push(b4h);
  if (!primary) throw new Error("no data");
  console.log(`data: BTC ${primary.t.length} bars, ${others.length} validation series\n`);
  const sealTs = Date.parse("2026-02-01");
  for (let seed = 1; seed <= 6; seed++) {
    const doc = randomStrategy(seed * 1009);
    const t0 = Date.now();
    try {
      const rep = runGauntlet({ doc, primary, others, sealTs, floors: DEFAULT_FLOORS, nTrialsTotal: 50 });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (rep.passed) {
        console.log(`PASS  ${doc.name} (${secs}s) wfSharpe=${rep.metrics.wfPooledSharpe?.toFixed(2)} dsr=${rep.metrics.dsr?.toFixed(3)}`);
      } else {
        console.log(`kill  ${doc.name} (${secs}s) at ${rep.failedStage}: ${rep.failedReason}`);
      }
    } catch (e) {
      console.log(`err   ${doc.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
main();
