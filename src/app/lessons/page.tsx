"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { timeAgo } from "../components/ui";

export default function LessonsPage() {
  const lessons = useQuery(api.pipeline.recentLessons, { limit: 100 });
  return (
    <section className="panel p-5">
      <div className="hud mb-1">Lessons journal</div>
      <p className="text-dim text-sm mb-4">Every failure and success writes a lesson. The next ideation cycle (Opus + GP operator weights) reads the last 25.</p>
      <div className="space-y-2">
        {lessons?.map((l) => (
          <div key={l._id} className="flex gap-3 text-sm border-t border-edge/60 pt-2">
            <span className="num text-dim text-xs w-16 shrink-0">{timeAgo(l.createdAt)}</span>
            <span className="num text-xs text-dim w-16 shrink-0">{l.source}</span>
            <span className={l.text.startsWith("PASSED") ? "text-up" : l.text.startsWith("FAILED") || l.text.includes("FAIL") ? "text-fg" : ""}>{l.text}</span>
          </div>
        ))}
        {!lessons?.length && <div className="text-dim text-sm">No lessons yet.</div>}
      </div>
    </section>
  );
}
