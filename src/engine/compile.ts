import * as S from "./series";
import { COMPLEXITY_LIMITS, type Bars, type Expr } from "./types";

export interface CompiledInputs {
  o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; v: Float64Array;
  /** last-known funding rate per bar (forward-filled from 8h stamps; 0 before first) */
  f: Float64Array;
  /** bar-open hour UTC (0-23) and day-of-week UTC (0=Sun..6=Sat) */
  hour: Float64Array;
  dow: Float64Array;
}

export function toArrays(bars: Bars): CompiledInputs {
  const n = bars.t.length;
  const f = new Float64Array(n);
  if (bars.fundingT && bars.fundingR && bars.fundingT.length) {
    let fi = 0;
    let last = 0;
    for (let i = 0; i < n; i++) {
      while (fi < bars.fundingT.length && bars.fundingT[fi] <= bars.t[i]) { last = bars.fundingR[fi]; fi++; }
      f[i] = last;
    }
  }
  const hour = new Float64Array(n);
  const dow = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const days = Math.floor(bars.t[i] / 86_400_000);
    hour[i] = Math.floor(bars.t[i] / 3_600_000) % 24;
    dow[i] = (days + 4) % 7; // epoch day 0 was a Thursday
  }
  return {
    o: Float64Array.from(bars.o), h: Float64Array.from(bars.h),
    l: Float64Array.from(bars.l), c: Float64Array.from(bars.c), v: Float64Array.from(bars.v),
    f, hour, dow,
  };
}

type Memo = Map<string, Float64Array | Uint8Array>;

function resolveScalar(e: Expr, params: Record<string, number>): number {
  const n = e as unknown as { op: string; value?: number; name?: string };
  if (n.op === "const") return n.value as number;
  if (n.op === "param") return params[n.name as string];
  throw new Error("period must be const or param");
}

function key(e: Expr, params: Record<string, number>): string {
  const n = e as unknown as Record<string, unknown> & { op: string };
  switch (n.op) {
    case "price": return `price:${n.field}`;
    case "funding": return "funding";
    case "hourutc": return "hourutc";
    case "dowutc": return "dowutc";
    case "const": return `c:${n.value}`;
    case "param": return `pv:${params[n.name as string]}`;
    default: {
      const parts: string[] = [n.op];
      for (const k of ["src", "period", "a", "b"]) if (n[k]) parts.push(key(n[k] as Expr, params));
      return parts.join("|");
    }
  }
}

/** Evaluate a numeric expression to a Float64Array (NaN during warmup). */
export function evalNum(e: Expr, inp: CompiledInputs, params: Record<string, number>, memo: Memo): Float64Array {
  const k = key(e, params);
  const cached = memo.get(k);
  if (cached) return cached as Float64Array;
  const n = e as unknown as Record<string, unknown> & { op: string };
  let out: Float64Array;
  const len = inp.c.length;
  switch (n.op) {
    case "price": {
      const f = n.field as string;
      out = f === "open" ? inp.o : f === "high" ? inp.h : f === "low" ? inp.l : f === "close" ? inp.c : inp.v;
      break;
    }
    case "funding": { out = inp.f; break; }
    case "hourutc": { out = inp.hour; break; }
    case "dowutc": { out = inp.dow; break; }
    case "const": { out = new Float64Array(len).fill(n.value as number); break; }
    case "param": { out = new Float64Array(len).fill(params[n.name as string]); break; }
    case "ema": case "sma": case "wma": case "rsi": case "stdev": case "highest": case "lowest":
    case "lag": case "zscore": case "slope": case "pctrank": case "median": case "roc": {
      const src = evalNum(n.src as Expr, inp, params, memo);
      let p = Math.round(resolveScalar(n.period as Expr, params));
      p = Math.max(1, Math.min(COMPLEXITY_LIMITS.maxPeriod, p));
      const fn = (S as unknown as Record<string, (s: Float64Array, p: number) => Float64Array>)[n.op];
      out = fn(src, p);
      break;
    }
    case "atr": {
      // atr ignores src semantics beyond requiring OHLC; period from node
      let p = Math.round(resolveScalar((n as { period?: Expr }).period as Expr, params));
      p = Math.max(1, Math.min(COMPLEXITY_LIMITS.maxPeriod, p));
      out = S.atr(inp.h, inp.l, inp.c, p);
      break;
    }
    case "add": case "sub": case "mul": case "div": case "min2": case "max2": {
      const a = evalNum(n.a as Expr, inp, params, memo);
      const b = evalNum(n.b as Expr, inp, params, memo);
      out = new Float64Array(len);
      for (let i = 0; i < len; i++) {
        const x = a[i], y = b[i];
        switch (n.op) {
          case "add": out[i] = x + y; break;
          case "sub": out[i] = x - y; break;
          case "mul": out[i] = x * y; break;
          case "div": out[i] = Math.abs(y) < 1e-12 ? NaN : x / y; break;
          case "min2": out[i] = Math.min(x, y); break;
          default: out[i] = Math.max(x, y);
        }
      }
      break;
    }
    case "abs": case "neg": case "log": case "sign": case "sqrt": {
      const a = evalNum(n.a as Expr, inp, params, memo);
      out = new Float64Array(len);
      for (let i = 0; i < len; i++) {
        const x = a[i];
        switch (n.op) {
          case "abs": out[i] = Math.abs(x); break;
          case "neg": out[i] = -x; break;
          case "log": out[i] = x > 0 ? Math.log(x) : NaN; break;
          case "sign": out[i] = Math.sign(x); break;
          default: out[i] = x >= 0 ? Math.sqrt(x) : NaN;
        }
      }
      break;
    }
    default:
      throw new Error(`evalNum: non-numeric op ${n.op}`);
  }
  memo.set(k, out);
  return out;
}

/** Evaluate a boolean expression to Uint8Array (0/1; NaN comparisons are 0). */
export function evalBool(e: Expr, inp: CompiledInputs, params: Record<string, number>, memo: Memo): Uint8Array {
  const k = `B|${key(e, params)}`;
  const cached = memo.get(k);
  if (cached) return cached as Uint8Array;
  const n = e as unknown as Record<string, unknown> & { op: string };
  const len = inp.c.length;
  let out: Uint8Array;
  switch (n.op) {
    case "gt": case "lt": {
      const a = evalNum(n.a as Expr, inp, params, memo);
      const b = evalNum(n.b as Expr, inp, params, memo);
      out = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        const x = a[i], y = b[i];
        if (Number.isNaN(x) || Number.isNaN(y)) continue;
        out[i] = (n.op === "gt" ? x > y : x < y) ? 1 : 0;
      }
      break;
    }
    case "crossover": case "crossunder": {
      const a = evalNum(n.a as Expr, inp, params, memo);
      const b = evalNum(n.b as Expr, inp, params, memo);
      out = new Uint8Array(len);
      for (let i = 1; i < len; i++) {
        const x0 = a[i - 1], y0 = b[i - 1], x1 = a[i], y1 = b[i];
        if (Number.isNaN(x0) || Number.isNaN(y0) || Number.isNaN(x1) || Number.isNaN(y1)) continue;
        out[i] = (n.op === "crossover" ? x0 <= y0 && x1 > y1 : x0 >= y0 && x1 < y1) ? 1 : 0;
      }
      break;
    }
    case "and": case "or": {
      const a = evalBool(n.a as Expr, inp, params, memo);
      const b = evalBool(n.b as Expr, inp, params, memo);
      out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = n.op === "and" ? (a[i] & b[i]) : (a[i] | b[i]);
      break;
    }
    case "not": {
      const a = evalBool(n.a as Expr, inp, params, memo);
      out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = a[i] ? 0 : 1;
      break;
    }
    default:
      throw new Error(`evalBool: non-boolean op ${n.op}`);
  }
  memo.set(k, out);
  return out;
}

export interface Signals {
  longEntry: Uint8Array; longExit: Uint8Array;
  shortEntry?: Uint8Array; shortExit?: Uint8Array;
  atr14: Float64Array; // for stop logic
}

export function computeSignals(
  doc: { longEntry: Expr; longExit: Expr; shortEntry?: Expr; shortExit?: Expr },
  inp: CompiledInputs,
  params: Record<string, number>,
): Signals {
  const memo: Memo = new Map();
  return {
    longEntry: evalBool(doc.longEntry, inp, params, memo),
    longExit: evalBool(doc.longExit, inp, params, memo),
    shortEntry: doc.shortEntry ? evalBool(doc.shortEntry, inp, params, memo) : undefined,
    shortExit: doc.shortExit ? evalBool(doc.shortExit, inp, params, memo) : undefined,
    atr14: S.atr(inp.h, inp.l, inp.c, 14),
  };
}
