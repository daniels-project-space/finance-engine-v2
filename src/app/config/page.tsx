"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../../convex/_generated/api";
import { Panel, Stat, fmt } from "../components/ds";

export default function ConfigPage() {
  const raw = useQuery(api.pipeline.getConfig, { key: "app" });
  const llmSpend = useQuery(api.pipeline.getCounter, { key: `llm_usd_cents:${new Date().toISOString().slice(0, 10)}` });
  const trials = useQuery(api.pipeline.getCounter, { key: "trials_total" });
  const setConfig = useMutation(api.pipeline.setConfig);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<"idle" | "ok" | "err">("idle");

  useEffect(() => {
    if (raw !== undefined && text === "") {
      try { setText(raw ? JSON.stringify(JSON.parse(raw), null, 2) : "{}"); } catch { setText(raw ?? "{}"); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);

  const save = async () => {
    try {
      JSON.parse(text);
      await setConfig({ key: "app", json: text });
      setSaved("ok"); setTimeout(() => setSaved("idle"), 1600);
    } catch { setSaved("err"); setTimeout(() => setSaved("idle"), 2000); }
  };

  return (
    <div className="space-y-4 stagger">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Panel pad="p-4"><Stat label="Trials (DSR deflation N)" value={trials ?? "·"} /></Panel>
        <Panel pad="p-4"><Stat label="LLM spend today" value={`$${((llmSpend ?? 0) / 100).toFixed(2)}`} tone="fg" /></Panel>
        <Panel pad="p-4"><Stat label="Config key" value="app" tone="dim" size="sm" sub="overrides defaults" /></Panel>
      </div>

      <Panel title="App config" right={
        <button onClick={save}
          className={`num text-[11px] px-3 py-1.5 rounded-md transition-colors ${saved === "ok" ? "text-up bg-up/10" : saved === "err" ? "text-down bg-down/10" : "text-mid bg-[#ffffff08] hover:bg-[#ffffff12]"}`}>
          {saved === "ok" ? "saved ✓" : saved === "err" ? "invalid JSON" : "save"}
        </button>
      }>
        <p className="num text-[10px] text-dim mb-3">Partial JSON merges over code defaults. Flags: xsection, ivsleeve, ocsleeve, onchain, marginalGate, historyStart, benchmark_spx, benchmark_btc.</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={20} spellCheck={false}
          className="w-full bg-base border border-[#ffffff0a] rounded-lg p-4 num text-xs text-mid outline-none focus:border-[#ffffff18] resize-y" />
      </Panel>
    </div>
  );
}
