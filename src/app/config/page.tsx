"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../../convex/_generated/api";

export default function ConfigPage() {
  const raw = useQuery(api.pipeline.getConfig, { key: "app" });
  const datasets = useQuery(api.pipeline.listDatasets, {});
  const llmSpend = useQuery(api.pipeline.getCounter, { key: `llm_usd_cents:${new Date().toISOString().slice(0, 10)}` });
  const trials = useQuery(api.pipeline.getCounter, { key: "trials_total" });
  const setConfig = useMutation(api.pipeline.setConfig);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (raw !== undefined && text === "") setText(raw ? JSON.stringify(JSON.parse(raw), null, 2) : "{}");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);

  const save = async () => {
    try {
      JSON.parse(text);
      await setConfig({ key: "app", json: text });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      alert("invalid JSON");
    }
  };

  return (
    <div className="space-y-6">
      <section className="panel p-5 flex gap-10">
        <div><div className="hud mb-1">Trials (DSR deflation N)</div><div className="num text-xl">{trials ?? "·"}</div></div>
        <div><div className="hud mb-1">LLM spend today</div><div className="num text-xl">${((llmSpend ?? 0) / 100).toFixed(2)}</div></div>
      </section>

      <section className="panel p-5">
        <div className="hud mb-3">Datasets</div>
        <table className="w-full text-sm num">
          <thead><tr className="hud text-left"><th className="pb-1">symbol</th><th>tf</th><th className="text-right">bars</th><th className="text-right">gaps</th><th className="text-right">last bar</th></tr></thead>
          <tbody>
            {datasets?.map((d) => (
              <tr key={d._id} className="border-t border-edge/60">
                <td className="py-1">{d.symbol}</td><td className="text-dim">{d.tf}</td>
                <td className="text-right">{d.bars.toLocaleString()}</td>
                <td className={`text-right ${d.gaps > 5 ? "text-down" : "text-dim"}`}>{d.gaps}</td>
                <td className="text-right text-dim text-xs">{new Date(d.lastTs).toISOString().slice(0, 16)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!datasets?.length && <div className="text-dim text-sm py-2">No datasets — trigger backfill-history.</div>}
      </section>

      <section className="panel p-5">
        <div className="hud mb-2">App config (overrides defaults; partial JSON fine)</div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={18} spellCheck={false}
          className="w-full bg-ink border border-edge rounded p-3 num text-xs" />
        <button onClick={save} className="mt-3 px-4 py-1.5 rounded border border-emerald-800 text-up hover:bg-emerald-950 num text-sm">
          {saved ? "saved ✓" : "save"}
        </button>
      </section>
    </div>
  );
}
