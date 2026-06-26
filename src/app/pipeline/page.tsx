"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Panel, Stat, compact } from "../components/ds";
import { Funnel, KillBars } from "../components/widgets2";

// PIPELINE — lean: three headline counts, the gauntlet funnel, and where
// strategies die. The full rigor-gate documentation table was removed (it lives in
// the engine; the funnel already shows the binding stages).
export default function PipelinePage() {
  const flow = useQuery(api.dashboard.stageFlow, {});
  const analytics = useQuery(api.candidates.analytics, {});

  return (
    <div className="space-y-5 stagger">
      <div className="grid grid-cols-3 gap-3">
        <Panel pad="p-4"><Stat label="Generated" value={compact(flow?.total)} /></Panel>
        <Panel pad="p-4"><Stat label="In gauntlet" value={compact(flow?.inGauntlet)} tone="info" /></Panel>
        <Panel pad="p-4"><Stat label="Survivors" value={flow?.survivors ?? 0} tone={(flow?.survivors ?? 0) > 0 ? "up" : "dim"} /></Panel>
      </div>

      <div className="grid lg:grid-cols-[1.5fr_1fr] gap-5">
        <Panel title="Gauntlet flow — reached vs killed per stage" pad="p-6">
          {flow && <Funnel rows={flow.rows} survivors={flow.survivors} />}
        </Panel>
        <Panel title="Where strategies die" pad="p-6">
          {analytics && <KillBars kills={analytics.killsByStage} max={10} />}
        </Panel>
      </div>
    </div>
  );
}
