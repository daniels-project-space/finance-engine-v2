"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Panel, Stat, Spark, Pill, fmt } from "../components/ds";

// orthogonality story: approximate correlation-to-market for each family (from the
// session research — the "diversification" narrative). Static descriptors of the
// established orthogonality of each alpha source.
const ORTHO: Record<string, { rho: string; tone: "down" | "accent" | "up" }> = {
  "DSL": { rho: "~0.85", tone: "down" },               // momentum ≈ market beta
  "Cross-sectional": { rho: "~0.40", tone: "accent" }, // partially orthogonal
  "IV-timing (DVOL)": { rho: "~0.18", tone: "up" },     // first orthogonal source
  "On-chain (MVRV/NVT)": { rho: "~0.33", tone: "accent" }, // strong standalone, moderate corr
};

// SLEEVES — lean: just the family cards (the orthogonal alpha sources). The intro
// blurb and the premium-survival table were removed for clarity.
export default function SleevesPage() {
  const families = useQuery(api.dashboard.sleeveFamilies, {});

  return (
    <div className="space-y-5 stagger">
      <div className="hud pt-2">Sleeve families — orthogonal alpha sources (ρ≈market shown)</div>
      <div className="grid md:grid-cols-2 gap-4">
        {(families ?? []).map((f) => {
          const o = ORTHO[f.family];
          return (
            <Panel key={f.family} pad="p-5" hover>
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <div className="text-fg font-semibold text-sm">{f.family}</div>
                  <div className="num text-[10px] text-dim mt-0.5 leading-snug">{f.desc}</div>
                </div>
                {o && <Pill tone={o.tone}>ρ≈mkt {o.rho}</Pill>}
              </div>
              <div className="flex items-end gap-5">
                <Stat label="Bred" value={f.bred} size="sm" />
                <Stat label="Scored" value={f.scored} size="sm" />
                <Stat label="Best OOS" value={fmt(f.bestOos)} tone={(f.bestOos ?? 0) > 0.5 ? "up" : "fg"} size="sm" />
                <Stat label="Mean OOS" value={fmt(f.meanOos)} tone="dim" size="sm" />
                <Stat label="Survivors" value={f.survivors} tone={f.survivors > 0 ? "up" : "dim"} size="sm" />
                <div className="ml-auto">
                  {f.bestCurve ? <Spark values={f.bestCurve.eq} width={130} height={32} tone="up" /> : <span className="hud">no curve</span>}
                </div>
              </div>
              <div className="mt-2.5 pt-2.5 border-t border-edge/50 flex items-center justify-between">
                <span className="num text-[10px] text-dim">deepest reached <span className="text-mid">{f.deepest}</span></span>
                {f.bestName && <span className="num text-[10px] text-dim truncate max-w-[180px]">best: {f.bestName}</span>}
              </div>
            </Panel>
          );
        })}
        {!families?.length && <div className="hud py-8 text-center col-span-2">loading families…</div>}
      </div>
    </div>
  );
}
