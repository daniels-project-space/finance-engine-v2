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

export default function SleevesPage() {
  const families = useQuery(api.dashboard.sleeveFamilies, {});
  const premium = useQuery(api.premium.premiumSnapshot, {});

  return (
    <div className="space-y-4 stagger">
      <Panel pad="p-4">
        <div className="hud mb-1">Sleeve families — the orthogonal alpha sources we built</div>
        <div className="num text-[11px] text-dim">A promotable book needs diversified sleeves (low mutual correlation). Market-beta momentum is exhausted; the edge is in the orthogonal lanes.</div>
      </Panel>

      <div className="grid md:grid-cols-2 gap-4">
        {(families ?? []).map((f) => {
          const o = ORTHO[f.family];
          return (
            <Panel key={f.family} pad="p-4" hover>
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

      {/* premium-family payoff table */}
      <Panel title="Risk-premium families — which premia actually pay">
        <div className="tablewrap">
          <table className="dt">
            <thead><tr><th>premium</th><th>attempts</th><th>survived</th><th>survival</th><th>mean comp</th><th>failed S4</th><th>failed sealed</th></tr></thead>
            <tbody>
              {(premium ?? []).sort((a, b) => b.attempts - a.attempts).map((p) => (
                <tr key={p.premium}>
                  <td style={{ textAlign: "left" }} className="text-mid">{p.premium.replace(/_/g, " ")}</td>
                  <td className="dt-num text-fg">{p.attempts}</td>
                  <td className="dt-num text-dim">{p.survived}</td>
                  <td className={`dt-num ${p.survivalRate > 0 ? "text-up" : "text-dim"}`}>{(p.survivalRate * 100).toFixed(0)}%</td>
                  <td className={`dt-num ${p.meanComposite > 0 ? "text-fg" : "text-down"}`}>{fmt(p.meanComposite)}</td>
                  <td className="dt-num text-dim">{p.failedS4}</td>
                  <td className="dt-num text-dim">{p.failedSealed}</td>
                </tr>
              ))}
              {!premium?.length && <tr><td colSpan={7} className="hud py-4" style={{ textAlign: "center" }}>no premium data yet</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
