import { ConvexHttpClient } from "convex/browser";
import { api } from "/home/ubuntu/finance-engine-v2/convex/_generated/api";
import { fetchSpx } from "/home/ubuntu/finance-engine-v2/src/lib/benchmark";
async function main() {
  const cx = new ConvexHttpClient(process.env.CONVEX_URL as string);
  const spx = await fetchSpx(console.log);
  if (!spx) throw new Error("no spx");
  await cx.mutation(api.pipeline.setConfig, { key: "benchmark_spx", json: JSON.stringify(spx) });
  console.log(`SPX seeded: ${spx.t.length} pts, ${new Date(spx.t[0]).toISOString().slice(0,10)} .. ${new Date(spx.t[spx.t.length-1]).toISOString().slice(0,10)}`);
}
main();
