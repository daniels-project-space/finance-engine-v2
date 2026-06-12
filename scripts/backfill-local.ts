import { aggregateBars, ingestSymbol, loadBars } from "../src/lib/data";
import { candleKey, putJsonGz } from "../src/lib/storage";
const UNIVERSE = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT"];
const START = Date.parse("2021-06-01");
async function main() {
  for (const s of UNIVERSE) {
    const r = await ingestSymbol(s, "1h", START, (m) => { if (m.includes("OUTLIER") || m.includes("failed")) console.log(" ", m); });
    console.log(`${s}: ${r.bars} bars (+${r.appended}) gaps=${r.gaps} funding->${r.fundingLastTs ? new Date(r.fundingLastTs).toISOString().slice(0,10) : "none"} src=${r.source} range ${new Date(r.firstTs).toISOString().slice(0,10)}..${new Date(r.lastTs).toISOString().slice(0,16)}`);
  }
  const primary = await loadBars("BTC/USDT", "1h");
  if (primary) {
    const agg = aggregateBars(primary, "4h");
    await putJsonGz(candleKey("BTC/USDT", "4h"), agg);
    console.log(`BTC 4h derived: ${agg.t.length} bars`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
