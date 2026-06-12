// Fable ideation via the locally-authenticated Claude Code CLI (headless -p
// mode — an official Claude Code feature included in the Max subscription).
// Personal-use automation: runs ONLY on this machine where the owner's CLI
// session is logged in, ~8 low-volume calls/day, no key extraction, no cloud
// credential copies. Proposals are schema-validated and then fight the same
// gauntlet as every other candidate — Fable gets ideas, not privileges.
//
// Usage: npx tsx scripts/ideate-cli.ts [nProposals]

import { execFile } from "node:child_process";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { buildPrompt, parseProposals } from "../src/engine/llm";
import { canonicalHash, familyHash, validateStrategy } from "../src/engine/dsl";
import { getAppConfig, processCandidate } from "../src/pipeline/process";
import { todayKey } from "../src/lib/appConfig";

const MODEL = "claude-fable-5";
const TIMEOUT_MS = 12 * 60 * 1000;

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      ["-p", "--model", MODEL],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, cwd: "/root" },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`claude cli: ${err.message.slice(0, 200)} ${String(stderr).slice(0, 200)}`));
        else resolve(stdout);
      },
    );
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

async function main() {
  const n = Number(process.argv[2] ?? "6");
  const url = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL missing");
  const cx = new ConvexHttpClient(url);
  const runId = await cx.mutation(api.pipeline.startRun, { kind: "ideate-fable" });
  try {
    const cfg = await getAppConfig(cx);
    const lessons = (await cx.query(api.pipeline.recentLessons, { limit: 30 })).map((l) => l.text);
    const champion = await cx.query(api.candidates.champion, {});
    const board = await cx.query(api.candidates.tournament, { limit: 8 });
    const boardSummary = board.map((b) => {
      const m = b.metrics ? JSON.parse(b.metrics) as Record<string, number> : {};
      return `"${b.name}" comp=${(b.composite ?? 0).toFixed(2)} portOOS=${(m.portOosSharpe ?? 0).toFixed(2)} btcWf=${(m.wfPooledSharpe ?? 0).toFixed(2)} died=${b.failedStage ?? "alive"}`;
    }).join("\n");
    const championSummary = champion
      ? `"${champion.name}" composite=${champion.composite?.toFixed(2)}: ${champion.hypothesis}`
      : `none yet. Current tournament board (best first):\n${boardSummary}`;

    const prompt = `${buildPrompt(lessons, "", n, championSummary)}

TARGET: deployed 5-pair portfolio OOS Sharpe >= 1.5 with CAGR >= 30%, surviving re-tuning walk-forward, cross-symbol generalization, DSR/permutation/bootstrap, stress, sealed holdout. Strategies are traded equal-weight across BTC/ETH/SOL/BNB/XRP perps — design rules that generalize ACROSS assets, not BTC-specific fits. The DSL has a "funding" operator ({"op":"funding"}) exposing the per-bar perp funding rate — carry/crowding mechanisms are encouraged.

Output ONLY the JSON object. No prose, no markdown fences.`;

    console.log(`asking ${MODEL} for ${n} proposals (${lessons.length} lessons in context)...`);
    const t0 = Date.now();
    const raw = await runClaude(prompt);
    console.log(`fable replied in ${((Date.now() - t0) / 1000).toFixed(0)}s (${raw.length} chars)`);
    const proposals = parseProposals(raw);
    console.log(`${proposals.length}/${n} proposals passed DSL validation`);

    let queued = 0, passed = 0;
    for (const p of proposals) {
      if (validateStrategy(p.doc).length > 0) continue;
      const hash = canonicalHash(p.doc);
      if (await cx.query(api.candidates.hashExists, { hash })) { console.log(`  dup: ${p.doc.name}`); continue; }
      p.doc.hypothesis = `${p.doc.hypothesis} [Fable/CLI] ${p.rationale.slice(0, 100)}`;
      const { id, duplicate } = await cx.mutation(api.candidates.create, {
        name: p.doc.name.startsWith("fable_") ? p.doc.name : `fable_${p.doc.name}`.slice(0, 40),
        source: "llm", dsl: JSON.stringify(p.doc), hash, familyHash: familyHash(p.doc), hypothesis: p.doc.hypothesis,
      });
      if (duplicate) continue;
      await cx.mutation(api.candidates.updateStage, { id, stage: "queued" });
      await cx.mutation(api.pipeline.bumpCounter, { key: todayKey("candidates"), by: 1 });
      queued++;
      const tC = Date.now();
      const res = await processCandidate(cx, id as unknown as string, () => {});
      const cand = await cx.query(api.candidates.get, { id });
      const secs = ((Date.now() - tC) / 1000).toFixed(0);
      if (res.passed) { passed++; console.log(`  PASS  ${cand?.name} (${secs}s) composite=${res.composite?.toFixed(2)}`); }
      else console.log(`  kill  ${cand?.name} (${secs}s) at ${res.stage}: ${cand?.failedReason ?? ""}`);
    }
    await cx.mutation(api.pipeline.finishRun, { id: runId, status: "ok", summary: JSON.stringify({ model: MODEL, proposals: proposals.length, queued, passed }) });
    console.log(`ideation done: ${queued} queued, ${passed} into incubation`);
  } catch (err) {
    await cx.mutation(api.pipeline.finishRun, { id: runId, status: "error", summary: String(err).slice(0, 400) });
    throw err;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
