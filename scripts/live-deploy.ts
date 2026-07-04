// LIVE-DEPLOY CLI — one command from "incubating sleeve" to "deployment".
//
//   npx tsx scripts/live-deploy.ts --list
//   npx tsx scripts/live-deploy.ts --name blend_eth_70_30_onchain_trend_seed --capital 1000
//   npx tsx scripts/live-deploy.ts --id <candidateId> --capital 500 --maxdd 20 --daily-loss 5
//   npx tsx scripts/live-deploy.ts --mode <deploymentId> live     # dryrun|live|halted|off
//
// New deployments ALWAYS start in dryrun. Flipping to live is this script's
// --mode command — an explicit human action, never automatic.

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

async function main() {
  const url = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL missing");
  const cx = new ConvexHttpClient(url);

  if (has("--list")) {
    const deps = await cx.query(api.live.listAll, {});
    if (!deps.length) { console.log("no deployments"); return; }
    for (const d of deps) {
      console.log(
        `${(d._id as string)}  [${d.mode.toUpperCase()}]  ${d.name}  ${d.symbol}\n` +
        `   equity $${d.equityUsd.toFixed(2)} (cap $${d.capitalUsd})  weight ${d.curWeight.toFixed(3)}  ` +
        `peak $${d.peakEquityUsd.toFixed(2)}  kill: -${d.maxDailyLossPct}%/day -${d.maxDrawdownPct}% DD` +
        (d.haltReason ? `\n   HALTED: ${d.haltReason}` : ""));
    }
    return;
  }

  const modeIdx = process.argv.indexOf("--mode");
  if (modeIdx >= 0) {
    const id = process.argv[modeIdx + 1], mode = process.argv[modeIdx + 2];
    if (!id || !mode) throw new Error("usage: --mode <deploymentId> <dryrun|live|halted|off>");
    if (mode === "live") {
      console.log("⚠️  Flipping to LIVE: real orders will be sent on the next executor run");
      console.log("    (requires the Binance key to have Spot & Margin Trading enabled).");
    }
    const r = await cx.mutation(api.live.setMode, { id: id as Id<"liveDeployments">, mode });
    console.log(`mode: ${r.from} -> ${r.to}`);
    return;
  }

  // ---- create ----
  const capital = Number(arg("--capital") ?? NaN);
  if (!Number.isFinite(capital) || capital <= 0) throw new Error("--capital <usd> required");
  let candidateId = arg("--id");
  const name = arg("--name");
  if (!candidateId && name) {
    const matches = await cx.query(api.candidates.findAliveByName, { name });
    if (!matches.length) throw new Error(`no ALIVE candidate named "${name}"`);
    if (matches.length > 1) {
      console.log("multiple matches — re-run with --id:");
      for (const m of matches) console.log(`  ${m.id}  ${m.stage}  composite ${m.composite}  created ${new Date(m.createdAt).toISOString().slice(0, 10)}`);
      return;
    }
    candidateId = matches[0].id as string;
  }
  if (!candidateId) throw new Error("--name <candidateName> or --id <candidateId> required");

  const r = await cx.mutation(api.live.create, {
    candidateId: candidateId as Id<"candidates">,
    capitalUsd: capital,
    ...(arg("--symbol") ? { symbol: arg("--symbol") } : {}),
    ...(arg("--max-weight") ? { maxWeight: Number(arg("--max-weight")) } : {}),
    ...(arg("--band") ? { rebalanceBand: Number(arg("--band")) } : {}),
    ...(arg("--daily-loss") ? { maxDailyLossPct: Number(arg("--daily-loss")) } : {}),
    ...(arg("--maxdd") ? { maxDrawdownPct: Number(arg("--maxdd")) } : {}),
  });
  console.log(r.created
    ? `created deployment ${r.id} in DRYRUN with $${capital} — executor picks it up next run.\nGo live later with: npx tsx scripts/live-deploy.ts --mode ${r.id} live`
    : `deployment already exists: ${r.id}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
