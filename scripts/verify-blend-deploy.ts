import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
const cx = new ConvexHttpClient(process.env.CONVEX_URL ?? "https://glad-poodle-88.convex.cloud");

async function main() {
  const recent = await cx.query(api.candidates.recent, { limit: 200 }) as any[];
  const names = ["blend_btc_70_30_onchain_trend_seed", "blend_btc_70_30_defensive_seed"];
  console.log("=== PAPER SLEEVES ===");
  for (const nm of names) {
    const c = recent.find((r) => r.name === nm);
    if (!c) { console.log(`  MISSING: ${nm}`); continue; }
    const dsl = c.dsl ? JSON.parse(c.dsl) : {};
    console.log(`  ${nm}\n     stage=${c.stage} bestParams=${c.bestParams} | dsl: wOnchain=${dsl.wOnchain} smaWin=${dsl.smaWin} nuplSell=${dsl.nuplSell} maWin=${dsl.maWin} belowMaCap=${dsl.belowMaCap}`);
  }
  console.log("\n=== MY STRATEGIES CARDS (order) ===");
  const cfg = JSON.parse(await cx.query(api.pipeline.getConfig, { key: "my_strategies" }) as string);
  cfg.strategies.forEach((s: any, i: number) =>
    console.log(`  #${i}${i === 0 ? " (HERO)" : ""}  key=${s.key.padEnd(16)} name="${s.name}" tag="${s.tag}" | ${s.total != null ? (s.total * 100).toFixed(0) + "% DD " + (s.maxDD * 100).toFixed(0) + "% Calmar " + s.calmar?.toFixed(2) : ""}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
