"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Panel, Stat, Pill, ago } from "../components/ds";
import { srcColor } from "../components/widgets2";

function tone(text: string): "up" | "down" | "dim" {
  if (text.startsWith("PASSED") || text.includes("ADMITTED") || text.includes("PROMOTED")) return "up";
  if (text.startsWith("FAILED") || text.includes("FAIL")) return "down";
  return "dim";
}

export default function LessonsPage() {
  const lessons = useQuery(api.pipeline.recentLessons, { limit: 150 });
  const passed = (lessons ?? []).filter((l) => tone(l.text) === "up").length;
  const failed = (lessons ?? []).filter((l) => tone(l.text) === "down").length;

  return (
    <div className="space-y-4 stagger">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Panel pad="p-4"><Stat label="Lessons logged" value={lessons?.length ?? "·"} /></Panel>
        <Panel pad="p-4"><Stat label="Passes" value={passed} tone="up" /></Panel>
        <Panel pad="p-4"><Stat label="Failures (learned from)" value={failed} tone="down" /></Panel>
      </div>

      <Panel title="Lessons journal" right={<span className="num text-[10px] text-dim">ideation reads the last 25</span>}>
        <div className="space-y-0">
          {(lessons ?? []).map((l) => {
            const t = tone(l.text);
            return (
              <div key={l._id} className="flex gap-3 text-xs items-baseline py-2 border-t border-[#ffffff07] first:border-t-0">
                <span className="num text-dim w-8 shrink-0 text-right">{ago(l.createdAt)}</span>
                <span className="num text-[10px] w-16 shrink-0" style={{ color: srcColor(l.source) }}>{l.source}</span>
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${t === "up" ? "bg-up" : t === "down" ? "bg-down" : "bg-faint"}`} />
                <span className={t === "up" ? "text-up/90" : t === "down" ? "text-mid" : "text-dim"}>{l.text}</span>
              </div>
            );
          })}
          {!lessons?.length && <div className="hud py-6 text-center">no lessons yet</div>}
        </div>
      </Panel>
    </div>
  );
}
