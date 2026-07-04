// Live target-weight adapter: turns a validated candidate's stored DSL into
// TODAY's target weight, reusing the exact engine code paths the paper sleeves
// step with (blendTargetNow / point-in-time SMA) so live and paper can never
// disagree on the signal. Long-flat spot only: weight is clamped to [0,1] —
// leverage is a paper-only concept until a margin executor exists.

import { loadBars, attachOnchain } from "../lib/data";
import { isBlendSleeve, blendTargetNow } from "../engine/blendsleeve";
import { isTrendBeta, buildTrendDaily } from "../engine/trendbeta";

export interface LiveTarget {
  symbol: string;
  weight: number;        // [0,1]
  lastTs: number;        // strategy bar the decision belongs to
  lastClose: number;
  note: string;
}
export type LiveTargetResult = { ok: true; target: LiveTarget } | { ok: false; error: string };

const MAX_BAR_AGE_MS = 2.5 * 86400_000; // daily strategies: bar must be recent

export async function computeLiveTarget(dslJson: string, bestParams?: string): Promise<LiveTargetResult> {
  let doc: unknown;
  try { doc = JSON.parse(dslJson); } catch { return { ok: false, error: "unparseable dsl" }; }
  let params: Record<string, number> = {};
  if (bestParams) { try { params = JSON.parse(bestParams) as Record<string, number>; } catch { /* defaults */ } }

  if (isBlendSleeve(doc)) {
    const bars0 = await loadBars(doc.symbol, "1d");
    if (!bars0) return { ok: false, error: `no 1d bars for ${doc.symbol}` };
    const bars = await attachOnchain(bars0, doc.symbol);
    const t = blendTargetNow(doc, bars);
    if (!t) return { ok: false, error: "blendTargetNow returned null (warm-up?)" };
    if (Date.now() - t.lastTs > MAX_BAR_AGE_MS) return { ok: false, error: `stale bar: last close ${new Date(t.lastTs).toISOString()}` };
    return {
      ok: true,
      target: {
        symbol: doc.symbol,
        weight: Math.min(1, Math.max(0, t.weight)),
        lastTs: t.lastTs,
        lastClose: t.lastClose,
        note: `blend legA=${t.legAW.toFixed(2)} legB=${t.legBW.toFixed(2)}`,
      },
    };
  }

  if (isTrendBeta(doc)) {
    const bars = await loadBars(doc.symbol, "1d");
    if (!bars) return { ok: false, error: `no 1d bars for ${doc.symbol}` };
    const S = buildTrendDaily(bars);
    const n = S.t.length;
    const win = Math.max(20, Math.round(params.smaWin ?? doc.smaWin));
    if (n < win + 2) return { ok: false, error: "not enough history for SMA" };
    const i = n - 1;
    if (Date.now() - S.t[i] > MAX_BAR_AGE_MS) return { ok: false, error: `stale bar: last close ${new Date(S.t[i]).toISOString()}` };
    let sma = 0;
    for (let k = i - win + 1; k <= i; k++) sma += S.close[k];
    sma /= win;
    const weight = S.close[i] >= sma ? 1 : 0; // spot: leverage clamped to 1
    return {
      ok: true,
      target: { symbol: doc.symbol, weight, lastTs: S.t[i], lastClose: S.close[i], note: `trend sma${win} ${S.close[i] >= sma ? "above" : "below"}` },
    };
  }

  const kind = (doc as { kind?: string })?.kind ?? "dsl";
  return { ok: false, error: `kind "${kind}" not yet supported for live execution (supported: blend, trendbeta)` };
}
