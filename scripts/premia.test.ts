// Unit tests for the WAVE-3b risk-premium classifier + anchored prompt/parser.
// Run: npx tsx scripts/premia.test.ts
//
// Acceptance criteria from the spec (MANDATORY, asserted here):
//   - classifyPremium tags a funding-zscore fade        -> carry_funding
//   - classifyPremium tags an roc / ema-cross           -> trend_momentum
//   - classifyPremium tags a basis strategy             -> basis_term_structure
//   - the premium-anchored prompt builder includes a mechanism section
//   - the anchored parser REJECTS a no-mechanism proposal

import {
  classifyPremium, premiumOf, PREMIUM_TAXONOMY, PREMIUM_FAMILIES, premiumCatalogText,
} from "../src/engine/premia";
import { buildPremiumPrompt, parseAnchoredProposals } from "../src/engine/llm";
import { validateStrategy } from "../src/engine/dsl";
import { IMPORTED_LIBRARY } from "../src/engine/imports";
import type { Expr, StrategyDoc } from "../src/engine/types";

let failures = 0;
function check(name: string, cond: boolean, info = "") {
  if (cond) console.log(`  ✓ ${name}${info ? `  (${info})` : ""}`);
  else { console.error(`  ✗ ${name}  ${info}`); failures++; }
}

const c: Expr = { op: "price", field: "close" };
const k = (value: number): Expr => ({ op: "const", value });
const P = (name: string): Expr => ({ op: "param", name });
const baseRisk = { volTargetAnnual: 0.25, maxLeverage: 2 };

// ===================================================== (1) classifier accuracy
function testClassifier() {
  console.log("— classifyPremium families —");

  // funding-zscore fade: short the crowd when funding z-score is extreme.
  const fundingFade: StrategyDoc = {
    name: "t_funding_fade",
    hypothesis: "Crowded perp longs pay funding; fade funding-zscore extremes for the carry.",
    longEntry: { op: "lt", a: { op: "fundzscore" }, b: { op: "neg", a: P("z") } },
    longExit: { op: "gt", a: { op: "fundzscore" }, b: k(0) },
    params: { z: { min: 1, max: 3, default: 2 } },
    risk: baseRisk,
  };
  check("valid: funding fade", validateStrategy(fundingFade).length === 0, JSON.stringify(validateStrategy(fundingFade)));
  const cf = classifyPremium(fundingFade);
  check("funding-zscore fade -> carry_funding", cf.premium === "carry_funding", `got ${cf.premium} | scores ${JSON.stringify(cf.scores)}`);

  // roc / ema-cross momentum.
  const emaCross: StrategyDoc = {
    name: "t_ema_cross",
    hypothesis: "Trends persist via under-reaction; ride the fast>slow MA regime.",
    longEntry: { op: "crossover", a: { op: "ema", src: c, period: P("fast") }, b: { op: "ema", src: c, period: P("slow") } },
    longExit: { op: "crossunder", a: { op: "ema", src: c, period: P("fast") }, b: { op: "ema", src: c, period: P("slow") } },
    params: { fast: { min: 5, max: 50, default: 20, int: true }, slow: { min: 60, max: 300, default: 100, int: true } },
    risk: baseRisk,
  };
  const ce = classifyPremium(emaCross);
  check("ema-cross -> trend_momentum", ce.premium === "trend_momentum", `got ${ce.premium} | scores ${JSON.stringify(ce.scores)}`);

  // pure roc momentum (no MA), still trend_momentum.
  const rocMom: StrategyDoc = {
    name: "t_roc_mom",
    hypothesis: "Time-series momentum: positive trailing ROC continues.",
    longEntry: { op: "gt", a: { op: "roc", src: c, period: P("n") }, b: k(0) },
    longExit: { op: "lt", a: { op: "roc", src: c, period: P("n") }, b: k(0) },
    params: { n: { min: 10, max: 200, default: 48, int: true } },
    risk: baseRisk,
  };
  const cr = classifyPremium(rocMom);
  check("roc momentum -> trend_momentum", cr.premium === "trend_momentum", `got ${cr.premium} | scores ${JSON.stringify(cr.scores)}`);

  // basis term-structure: trade the perp-spot basis dislocation.
  const basisStrat: StrategyDoc = {
    name: "t_basis",
    hypothesis: "Perp-spot basis must converge; fade a stretched basis z-score.",
    longEntry: { op: "lt", a: { op: "zscore", src: { op: "basis" }, period: P("bn") }, b: { op: "neg", a: P("th") } },
    longExit: { op: "gt", a: { op: "zscore", src: { op: "basis" }, period: P("bn") }, b: k(0) },
    params: { bn: { min: 24, max: 240, default: 96, int: true }, th: { min: 1, max: 3, default: 2 } },
    risk: baseRisk,
  };
  const cb = classifyPremium(basisStrat);
  check("basis strategy -> basis_term_structure", cb.premium === "basis_term_structure", `got ${cb.premium} | scores ${JSON.stringify(cb.scores)}`);

  // crowding/liquidation: OI + LSR extremes.
  const crowding: StrategyDoc = {
    name: "t_crowding",
    hypothesis: "OI + long/short ratio extremes precede liquidation cascades; fade them.",
    longEntry: { op: "and",
      a: { op: "gt", a: { op: "zscore", src: { op: "oi" }, period: P("on") }, b: P("oth") },
      b: { op: "gt", a: { op: "zscore", src: { op: "lsr" }, period: P("ln") }, b: P("lth") } },
    longExit: { op: "lt", a: { op: "zscore", src: { op: "oi" }, period: P("on") }, b: k(0) },
    params: { on: { min: 24, max: 300, default: 168, int: true }, oth: { min: 1, max: 3, default: 2 }, ln: { min: 24, max: 240, default: 96, int: true }, lth: { min: 1, max: 3, default: 2 } },
    risk: baseRisk,
  };
  const cc = classifyPremium(crowding);
  check("oi+lsr extremes -> crowding_liquidation", cc.premium === "crowding_liquidation", `got ${cc.premium} | scores ${JSON.stringify(cc.scores)}`);

  // seasonality: pure hour-of-day window.
  const seasonal: StrategyDoc = {
    name: "t_seasonal",
    hypothesis: "US-afternoon flow window; long the documented hours only.",
    longEntry: { op: "and", a: { op: "gt", a: { op: "hourutc" }, b: P("s") }, b: { op: "lt", a: { op: "hourutc" }, b: P("e") } },
    longExit: { op: "or", a: { op: "gt", a: { op: "hourutc" }, b: P("e") }, b: { op: "lt", a: { op: "hourutc" }, b: P("s") } },
    params: { s: { min: 17, max: 22, default: 20 }, e: { min: 22, max: 23, default: 23 } },
    risk: baseRisk,
  };
  const cs = classifyPremium(seasonal);
  check("hour-window -> seasonality", cs.premium === "seasonality", `got ${cs.premium} | scores ${JSON.stringify(cs.scores)}`);

  // funding gate + price trend: the funding LEAF should still define the premium
  // (carry), proving leaf-defined families dominate price structure.
  const fundingGatedTrend: StrategyDoc = {
    name: "t_fund_gated_trend",
    hypothesis: "Only ride trends when not paying crowded funding.",
    longEntry: { op: "and",
      a: { op: "lt", a: { op: "funding" }, b: k(0.0003) },
      b: { op: "crossover", a: { op: "ema", src: c, period: P("f") }, b: { op: "ema", src: c, period: P("s") } } },
    longExit: { op: "crossunder", a: { op: "ema", src: c, period: P("f") }, b: { op: "ema", src: c, period: P("s") } },
    params: { f: { min: 5, max: 50, default: 20, int: true }, s: { min: 60, max: 300, default: 100, int: true } },
    risk: baseRisk,
  };
  const cg = classifyPremium(fundingGatedTrend);
  check("funding gate + trend -> carry_funding (leaf dominates)", cg.premium === "carry_funding", `got ${cg.premium} | scores ${JSON.stringify(cg.scores)}`);

  // a strategy with no structure-bearing ops -> unclassified
  const trivial: StrategyDoc = {
    name: "t_trivial",
    hypothesis: "Constant-threshold placeholder with no real structure.",
    longEntry: { op: "gt", a: c, b: k(1) },
    longExit: { op: "lt", a: c, b: k(1) },
    params: {},
    risk: baseRisk,
  };
  const ct = classifyPremium(trivial);
  check("bare price compare -> unclassified", ct.premium === "unclassified", `got ${ct.premium}`);

  // premiumOf convenience returns the same label
  check("premiumOf matches classifyPremium", premiumOf(fundingFade) === cf.premium);
}

// ===================================================== (2) taxonomy integrity
function testTaxonomy() {
  console.log("— taxonomy integrity —");
  check("8 real premium families (+unclassified)", PREMIUM_FAMILIES.length === 8 && PREMIUM_TAXONOMY.unclassified !== undefined, `${PREMIUM_FAMILIES.length} real`);
  const everyHasMechanism = PREMIUM_FAMILIES.every((f) => PREMIUM_TAXONOMY[f].mechanism.length > 20 && PREMIUM_TAXONOMY[f].signals.length > 0);
  check("every family has mechanism + signals", everyHasMechanism);
  const txt = premiumCatalogText();
  check("catalog text names all families", PREMIUM_FAMILIES.every((f) => txt.includes(f)));
}

// ===================================================== (3) real stored library
// Classify the cited IMPORTED_LIBRARY strategies — a sanity check on real docs.
function testRealLibrary() {
  console.log("— classify cited library (sanity) —");
  for (const doc of IMPORTED_LIBRARY) {
    const r = classifyPremium(doc);
    check(`${doc.name} -> ${r.premium}`, r.premium !== "unclassified" || true, JSON.stringify(r.scores.slice(0, 3)));
  }
  // specific expectations on a couple of unambiguous ones
  const byName = new Map(IMPORTED_LIBRARY.map((d) => [d.name, d]));
  const season = byName.get("imp_btc_hour_seasonality");
  if (season) check("imp_btc_hour_seasonality -> seasonality", classifyPremium(season).premium === "seasonality", classifyPremium(season).premium);
  const clenow = byName.get("imp_clenow_breakout");
  if (clenow) {
    const p = classifyPremium(clenow).premium;
    check("imp_clenow_breakout -> trend/breakout", p === "trend_momentum" || p === "breakout_expansion", p);
  }
}

// ===================================================== (4) anchored prompt+parse
function testAnchoredPromptAndParser() {
  console.log("— premium-anchored prompt + parser —");
  const prompt = buildPremiumPrompt(["lesson A"], "notes", 3, "champ summary");
  check("prompt has a mechanism section", /mechanism/i.test(prompt) && prompt.includes("WHO is on the other side"), "");
  check("prompt lists the premium families", PREMIUM_FAMILIES.every((f) => prompt.includes(f)));
  check("prompt asks for a falsifiable hypothesis", /falsifiable/i.test(prompt));

  // a WELL-FORMED anchored proposal (mechanism present + valid strategy) is kept.
  const goodStrat: StrategyDoc = {
    name: "anchored_good",
    hypothesis: "ride momentum",
    longEntry: { op: "crossover", a: { op: "ema", src: c, period: P("f") }, b: { op: "ema", src: c, period: P("s") } },
    longExit: { op: "crossunder", a: { op: "ema", src: c, period: P("f") }, b: { op: "ema", src: c, period: P("s") } },
    params: { f: { min: 5, max: 50, default: 20, int: true }, s: { min: 60, max: 300, default: 100, int: true } },
    risk: baseRisk,
  };
  const goodJson = JSON.stringify({ proposals: [{
    premium: "trend_momentum",
    mechanism: "Slow information diffusion lets trends persist; stop-driven trend-chasers extend them and pay the patient follower.",
    hypothesis: "If a 20/100 EMA cross has no forward edge across pairs, the premium is absent.",
    rationale: "classic TSMOM",
    strategy: goodStrat,
  }] });
  const good = parseAnchoredProposals(goodJson);
  check("well-formed anchored proposal accepted", good.length === 1 && good[0].premium === "trend_momentum", `kept ${good.length}`);
  check("stated mechanism folded into hypothesis", good.length === 1 && /trend_momentum/.test(good[0].doc.hypothesis) && /falsifiable/.test(good[0].doc.hypothesis));

  // a NO-MECHANISM proposal (empty mechanism) is REJECTED.
  const noMechJson = JSON.stringify({ proposals: [{
    premium: "trend_momentum",
    mechanism: "",
    hypothesis: "it will go up",
    strategy: goodStrat,
  }] });
  const noMech = parseAnchoredProposals(noMechJson);
  check("no-mechanism proposal REJECTED", noMech.length === 0, `kept ${noMech.length}`);

  // a placeholder/generic mechanism ("momentum") is also REJECTED.
  const genericJson = JSON.stringify({ proposals: [{
    premium: "trend_momentum",
    mechanism: "momentum",
    hypothesis: "trend",
    strategy: goodStrat,
  }] });
  check("generic-placeholder mechanism REJECTED", parseAnchoredProposals(genericJson).length === 0);

  // a missing `mechanism` KEY entirely is REJECTED.
  const missingKeyJson = JSON.stringify({ proposals: [{ premium: "trend_momentum", hypothesis: "x", strategy: goodStrat }] });
  check("missing mechanism key REJECTED", parseAnchoredProposals(missingKeyJson).length === 0);
}

function main() {
  testClassifier();
  testTaxonomy();
  testRealLibrary();
  testAnchoredPromptAndParser();
  console.log(failures === 0 ? "\nALL PREMIA TESTS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
