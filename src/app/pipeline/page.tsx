"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Panel, Stat, fmt, compact } from "../components/ds";
import { Funnel, KillBars } from "../components/widgets2";

// the rigor gates applied in the stats stages — surfaced so the "what protects us
// from overfitting" story is explicit. Static descriptors (the gates themselves
// live in the engine; this is documentation of the binding checks).
const GATES = [
  { stage: "S3", name: "Re-tuning walk-forward", desc: "params re-fit each OOS window; pooled OOS Sharpe must hold", binds: "OOS Sharpe, % positive windows" },
  { stage: "S4", name: "Cross-symbol + portfolio", desc: "must generalize across the universe, not one pair", binds: "cross-symbol positivity, portfolio OOS" },
  { stage: "S5", name: "Deflated Sharpe (DSR)", desc: "PSR vs expected-max of N family trials — multiple-testing deflation", binds: "DSR ≥ floor (family-scoped N)" },
  { stage: "S5", name: "Permutation test", desc: "market-return shuffle null; edge must need real temporal structure", binds: "p < 0.05" },
  { stage: "S5", name: "Bootstrap CI", desc: "block-bootstrap Sharpe lower band must be positive", binds: "p5 > 0" },
  { stage: "S5b", name: "Stress / regime", desc: "survives regime breakdown + cost stress", binds: "per-regime Sharpe" },
  { stage: "S5c", name: "PBO (CSCV)", desc: "probability of backtest overfitting across configs", binds: "PBO < 0.5" },
  { stage: "S6", name: "Sealed holdout", desc: "untouched holdout slice — never seen during tuning", binds: "sealed Sharpe > 0" },
];

export default function PipelinePage() {
  const flow = useQuery(api.dashboard.stageFlow, {});
  const analytics = useQuery(api.candidates.analytics, {});

  return (
    <div className="space-y-4 stagger">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Panel pad="p-3.5"><Stat label="Generated" value={compact(flow?.total)} /></Panel>
        <Panel pad="p-3.5"><Stat label="In gauntlet" value={compact(flow?.inGauntlet)} tone="info" /></Panel>
        <Panel pad="p-3.5"><Stat label="Reached S5 / DSR" value={compact(flow?.reachedS5)} tone="accent" /></Panel>
        <Panel pad="p-3.5"><Stat label="Penalty-boxed" value={compact(flow?.penalty)} tone="dim" /></Panel>
        <Panel pad="p-3.5"><Stat label="Survivors" value={flow?.survivors ?? 0} tone={(flow?.survivors ?? 0) > 0 ? "up" : "dim"} /></Panel>
      </div>

      <div className="grid lg:grid-cols-[1.5fr_1fr] gap-4">
        <Panel title="Full gauntlet flow — reached vs killed per stage" right={<span className="num text-[10px] text-dim">one pipeline · all lanes folded</span>}>
          {flow && <Funnel rows={flow.rows} survivors={flow.survivors} />}
        </Panel>
        <Panel title="Kill distribution — where strategies die">
          {analytics && <KillBars kills={analytics.killsByStage} max={12} />}
        </Panel>
      </div>

      <Panel title="Rigor gates — the overfitting defenses (S5/S5b/S5c/S6)">
        <div className="tablewrap">
          <table className="dt">
            <thead><tr><th>gate</th><th style={{ textAlign: "left" }}>what it checks</th><th style={{ textAlign: "left" }}>binds on</th><th>stage</th></tr></thead>
            <tbody>
              {GATES.map((g, i) => (
                <tr key={i}>
                  <td style={{ textAlign: "left" }} className="text-fg">{g.name}</td>
                  <td style={{ textAlign: "left" }} className="text-mid text-xs">{g.desc}</td>
                  <td style={{ textAlign: "left" }} className="num text-[11px] text-dim">{g.binds}</td>
                  <td><span className="pill pill-soft text-dim">{g.stage}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="num text-[10px] text-dim mt-3">
          Independently validated against canonical refs (purgedcv / skfolio): DSR, PSR, PBO, purged-WF all confirmed correct.
        </div>
      </Panel>
    </div>
  );
}
