// Opus ideation via the locally-authenticated Claude Code CLI (headless -p
// mode — an official Claude Code feature included in the Max subscription).
// Personal-use automation: runs ONLY on this machine where the owner's CLI
// session is logged in, ~8 low-volume calls/day, no key extraction, no cloud
// credential copies. Proposals are schema-validated and then fight the same
// gauntlet as every other candidate — Opus gets ideas, not privileges.
//
// Usage: npx tsx scripts/ideate-cli.ts [nProposals]

import { execFile } from "node:child_process";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { buildPrompt, parseProposals } from "../src/engine/llm";
import { modelForLane } from "../src/engine/model";
import { canonicalHash, familyHash, validateStrategy } from "../src/engine/dsl";
import { getAppConfig, processCandidate } from "../src/pipeline/process";
import { todayKey } from "../src/lib/appConfig";

// Strategy-lane model via the typo-proof resolver (Opus by default; never the
// dead "claude-fable-5"). Subscription CLI only — ANTHROPIC_API_KEY is stripped
// from the child env so this can never bill the API.
const MODEL = modelForLane("strategy");
const TIMEOUT_MS = Number(process.env.EVOLUTION_LLM_TIMEOUT_MS ?? 12 * 60 * 1000);

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // subscription-only
    const child = execFile(
      process.env.CLAUDE_BIN || "claude",
      ["-p", "--model", MODEL, "--output-format", "json"],
      { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, cwd: process.env.CLAUDE_CWD || "/root", env },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`claude cli (${MODEL}): ${err.message.slice(0, 200)} ${String(stderr).slice(0, 200)}`));
        try {
          const j = JSON.parse(stdout) as { is_error?: boolean; subtype?: string; result?: string };
          if (j.is_error || j.subtype !== "success") return reject(new Error(`claude cli (${MODEL}) error: ${String(j.result ?? j.subtype).slice(0, 200)}`));
          resolve(j.result ?? "");
        } catch {
          resolve(stdout); // tolerate a raw-text reply
        }
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
  const runId = await cx.mutation(api.pipeline.startRun, { kind: "ideate-opus" });
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

    const bestComposite = Math.max(0, ...board.map((b) => b.composite ?? 0));
    const failureForensics = board.slice(0, 6).map((b) => {
      const m = b.metrics ? JSON.parse(b.metrics) as Record<string, number> : {};
      // GENERATION-STEER: surface the cross-symbol breakdown so the model SEES that
      // a leader is a single-symbol (BTC) overfit — strong BTC WF Sharpe but
      // generalizing to too few of the 5 perps — the dominant cause of death at S4.
      const xsym = m.crossSymbolPositive;
      const xsymNote = b.failedStage === "S4-cross-symbol" && typeof xsym === "number"
        ? ` — GENERALIZED ON ONLY ${xsym}/6 PERPS (great on BTC, failed on the rest = single-symbol overfit)`
        : "";
      return `"${b.name}": btcWfSharpe=${(m.wfPooledSharpe ?? 0).toFixed(2)} fullSharpe=${(m.fullSharpe ?? 0).toFixed(2)} maxDD=${((m.fullMaxDD ?? 0) * 100).toFixed(0)}% — killed at ${b.failedStage}: ${b.failedReason}${xsymNote}`;
    }).join("\n");

    // GENERATION-STEER: the top-composite board can be dominated by penalty-boxed
    // families, hiding the S4 cross-symbol deaths. Pull recent S4-cross-symbol
    // failures directly so the universality signal always reaches the model, with
    // the concrete per-symbol breakdown (strong BTC WF Sharpe, generalized on too
    // few perps). These are the EXACT failures the new ideas must avoid.
    const recentFailed = await cx.query(api.candidates.listByStage, { stage: "failed", limit: 60 });
    const xsymDeaths = recentFailed.filter((b) => b.failedStage === "S4-cross-symbol").slice(0, 6);
    const xsymForensics = xsymDeaths.map((b) => {
      const m = b.metrics ? JSON.parse(b.metrics) as Record<string, number> : {};
      return `"${b.name}": btcWfSharpe=${(m.wfPooledSharpe ?? 0).toFixed(2)} but WF-positive on ONLY ${m.crossSymbolPositive ?? "?"}/6 perps — a BTC overfit that failed on ETH/SOL/BNB/XRP`;
    }).join("\n");
    // How many recent candidates died specifically because they only worked on BTC—
    // makes the universality mandate concrete in the prompt (board + dedicated pull).
    const btcOnlyDeaths = xsymDeaths.length + board.slice(0, 6).filter((b) => b.failedStage === "S4-cross-symbol").length;

    const prompt = `${buildPrompt(lessons, "", n, championSummary)}

MISSION: the current best composite on the board is ${bestComposite.toFixed(2)}. Your strategies must aim to BEAT ${(bestComposite * 2).toFixed(2)} (double). Failure forensics of the current leaders — design around these exact causes of death:
${failureForensics}

CRITICAL — CROSS-SECTIONAL UNIVERSALITY (this is why strategies keep dying): ${btcOnlyDeaths} recent candidates were killed at S4 because they only generalized to 1-2 of the 5 perps — strong on BTC but really BTC-specific overfits. Concrete recent examples:
${xsymForensics || "(none in the last batch — keep it that way)"}
 Each strategy is tuned and traded SEPARATELY on EACH of BTC/ETH/SOL/BNB/XRP and must be WF-positive on at least 3 of them. So propose mechanisms grounded in UNIVERSAL perp microstructure that behaves identically across every USDT perp — funding rate / funding z-score+acceleration ({"op":"fundzscore"}/{"op":"fundaccel"}), perp-spot basis ({"op":"basis"}), open-interest dynamics ({"op":"oi"}), taker long/short ratio ({"op":"lsr"}), and scale-free normalized price structure (zscore/pctrank, never raw price levels or BTC-specific thresholds). AVOID: absolute price/dollar thresholds, hand-tuned constants that only make sense for BTC, and any pattern whose edge depends on one asset\'s idiosyncratic history. ASK YOURSELF for every rule: "would this same rule, re-tuned, profit on SOL and XRP too?" If not, redesign it.

TARGET: deployed 5-pair portfolio OOS Sharpe >= 1.5 with CAGR >= 30%, surviving re-tuning walk-forward, cross-symbol generalization, DSR/permutation/bootstrap, stress, sealed holdout. Strategies are traded equal-weight across BTC/ETH/SOL/BNB/XRP perps. The funding/basis/oi/lsr operators expose universal perp dynamics — carry/crowding/positioning mechanisms are strongly encouraged because they generalize cross-sectionally. Mind the floors that killed the leaders: OOS maxDD must stay above -30%, worst month above -15%, >=55% positive months at PORTFOLIO level. Use the risk overlay (stopAtrMult/trailAtrMult/volTargetAnnual) deliberately — drawdown control is what the near-misses lacked.

Output ONLY the JSON object. No prose, no markdown fences.`;

    console.log(`asking ${MODEL} for ${n} proposals (${lessons.length} lessons in context)...`);
    const t0 = Date.now();
    const raw = process.env.IDEATE_RAW
      ? (await import("node:fs")).readFileSync(process.env.IDEATE_RAW, "utf-8")
      : await runClaude(prompt);
    console.log(`claude replied in ${((Date.now() - t0) / 1000).toFixed(0)}s (${raw.length} chars)`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/ideate-raw.txt", raw);
    const proposals = parseProposals(raw);
    console.log(`${proposals.length}/${n} proposals passed DSL validation`);
    if (proposals.length === 0) {
      // diagnose: was it a parse failure or validation kills?
      try {
        const cleaned = raw.replace(/```json\s*/g, "").replace(/```/g, "");
        const m = cleaned.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(m ? m[0] : cleaned) as { proposals?: { strategy?: unknown }[] };
        console.log(`parse OK, ${parsed.proposals?.length ?? 0} raw proposals; validation errors:`);
        for (const item of parsed.proposals ?? []) {
          const doc = item.strategy as Parameters<typeof validateStrategy>[0];
          if (doc) console.log(`  - ${(doc as { name?: string }).name}: ${validateStrategy(doc).join("; ") || "valid?"}`);
        }
      } catch (e) {
        console.log(`JSON parse failed: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
        console.log(`raw head: ${raw.slice(0, 400)}`);
      }
    }

    let queued = 0, passed = 0;
    for (const p of proposals) {
      if (validateStrategy(p.doc).length > 0) continue;
      const hash = canonicalHash(p.doc);
      if (await cx.query(api.candidates.hashExists, { hash })) { console.log(`  dup: ${p.doc.name}`); continue; }
      p.doc.hypothesis = `${p.doc.hypothesis} [Opus/CLI] ${p.rationale.slice(0, 100)}`;
      const { id, duplicate } = await cx.mutation(api.candidates.create, {
        name: p.doc.name.startsWith("opus_") ? p.doc.name : `opus_${p.doc.name}`.slice(0, 40),
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
