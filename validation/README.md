# Validation sidecar — independent gauntlet-math trust layer (Phase 3)

**OFFLINE** harness that independently verifies the hand-rolled gauntlet statistics
(`src/engine/stats.ts`, `src/engine/rigor.ts`) against canonical reference
implementations. It is **NOT** a runtime dependency — nothing here is imported by
the live engine or the Trigger build. Run it on demand / in CI before trusting a
gate for a real-money decision.

It exists because two bugs were found in the DSR/PSR math this session:
1. trial-count scoped all-time instead of per-family, and
2. the deflation benchmark was compared in annualized units against a per-bar PSR.

This harness is the independent confirmation that the **fixes are correct**.

## What it checks

| Gate | Our code | Canonical reference |
|------|----------|---------------------|
| PSR  | `stats.ts::psr` | `purgedcv.probabilistic_sharpe_ratio` (Bailey & López de Prado 2012) |
| DSR  | `stats.ts::dsr` | `purgedcv.deflated_sharpe_ratio` (+ `bars_per_year` units conversion) (B&LdP 2014) |
| sr\* | the deflated benchmark inside `dsr` | `purgedcv.deflated_sharpe_ratio_full.sr_star` |
| PBO  | `rigor.ts::pboFromMatrix` (CSCV) | `purgedcv.probability_of_backtest_overfitting` |
| purged-WF | `rigor.ts::applyPurgeEmbargo` | canonical purge+embargo band + `skfolio.CombinatorialPurgedCV` |

## How to run

```bash
# one-time: create the venv + install clean-licensed refs
python3 -m venv validation/.venv
validation/.venv/bin/pip install purgedcv skfolio numpy scipy

# 1) export OUR statistics on the representative battery -> validation/cases.json
npx tsx validation/export_cases.ts validation/cases.json

# 2) recompute via the canonical refs and print the per-gate agreement report
validation/.venv/bin/python validation/validate.py validation/cases.json
#    exit 0 = all gates confirmed; exit 1 = a discrepancy (see the report)
```

Or both steps: `bash validation/run.sh`

## Cases

`export_cases.ts` runs the **real production functions** on:
- **synthetic streams of known properties**: Gaussian annualized-Sharpe 0/1/2/3 at
  N∈{40,250,1000}, both 1h (ppy 8760) and 1d (ppy 365), trial counts N∈{10,40,200};
- **skewed / fat-tailed** streams (exercise the PSR skew/kurtosis correction);
- **realistic messy candidate streams**: AR(1) momentum-like, sparse on-chain-like,
  borderline near-floor (annual SR 0.9–1.5 — the exact zone the units fix put the gate at);
- **guard cases** (n<10, zero variance);
- **PBO matrices** of known overfit character (pure noise, genuine skill, mixed);
- **purge/embargo** index sets at boundaries (mid/start/end fold, zero embargo, large window).

## Result (last run)

```
SR_STAR : CONFIRMED   max absdiff = 4.28e-11    <- THE UNITS FIX, exact
PSR     : CONFIRMED   max absdiff = 7.37e-08
DSR     : CONFIRMED   max absdiff = 7.24e-08
PBO     : CONFIRMED   max absdiff = 1.59e-02  (within 0.02 CSCV tol)
PURGE   : CONFIRMED   exact set match + zero leakage (also via skfolio CPCV, 45 paths, 0 leaks)
TRUST VERDICT: ALL GATES INDEPENDENTLY CONFIRMED
```

### Documented convention difference (NOT a bug)

Our `psr()` uses **population (biased, `/n`) skew & kurtosis** — the convention of
the canonical Bailey & López de Prado / mlfinlab reference PSR (scipy default
`bias=True`). `purgedcv` uses the **bias-corrected** variant. The two agree to
machine precision once moments are matched; they diverge by **< 9e-4** only at the
smallest sample (n=40), because the bias-correction factor → 1 as n grows. Ours
matches the original published reference, so we keep it. The harness reports this
gap explicitly rather than masking it.

`psr()` also returns 0 by design for n<10 or zero-variance inputs (a deliberate
guard); `purgedcv` raises instead. Documented as a convention, not compared numerically.

## Licenses (all permissive, offline)

- `purgedcv` — MIT
- `skfolio` — BSD-3-Clause
- `numpy`, `scipy` — BSD-3-Clause

## Guardrails honored

- Offline only; no import added to the live engine / Trigger path.
- Live gauntlet behavior unchanged — no `src/` file modified (validated by the
  harness *as written*, not a reimplementation).
- Reversible: delete `validation/` to remove entirely.
