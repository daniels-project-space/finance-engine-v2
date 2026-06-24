import { createHash } from "node:crypto";
import { COMPLEXITY_LIMITS, type Expr, type ParamSpec, type StrategyDoc } from "./types";

const PRICE_FIELDS = new Set(["open", "high", "low", "close", "volume"]);
const IND_OPS = new Set(["ema", "sma", "wma", "rsi", "atr", "stdev", "highest", "lowest", "lag", "zscore", "slope", "pctrank", "median", "roc"]);
const BIN_OPS = new Set(["add", "sub", "mul", "div", "min2", "max2"]);
const UN_OPS = new Set(["abs", "neg", "log", "sign", "sqrt"]);
const CMP_OPS = new Set(["gt", "lt", "crossover", "crossunder"]);
const LOGIC_OPS = new Set(["and", "or"]);
const COMMUTATIVE = new Set(["add", "mul", "min2", "max2", "and", "or"]);
// Nullary numeric leaf inputs (no children): market-data series read per bar.
// WAVE-3a adds the crypto-native inputs alongside funding + the calendar ops.
const NULLARY_NUM = new Set([
  "funding", "hourutc", "dowutc",
  "fundroc", "fundzscore", "fundaccel", "fundmom", "basis", "oi", "lsr",
  // on-chain leaf inputs (daily, BTC/ETH; forward-filled + lagged)
  "mvrv", "activeaddr", "txcnt", "nvt", "exnetflow", "stablesupply",
]);

export type ExprKind = "num" | "bool";

export class DslError extends Error {}

/** Validate structure + types. Returns the expression's kind. Throws DslError. */
export function checkExpr(e: unknown, params: Record<string, ParamSpec>, depth = 0): ExprKind {
  if (depth > COMPLEXITY_LIMITS.maxDepth) throw new DslError("max depth exceeded");
  if (typeof e !== "object" || e === null || typeof (e as { op?: unknown }).op !== "string") throw new DslError("malformed node");
  const node = e as Record<string, unknown> & { op: string };
  const op = node.op;
  if (op === "price") {
    if (!PRICE_FIELDS.has(node.field as string)) throw new DslError(`bad price field ${node.field}`);
    return "num";
  }
  if (NULLARY_NUM.has(op)) return "num";
  if (op === "const") {
    if (typeof node.value !== "number" || !Number.isFinite(node.value)) throw new DslError("bad const");
    return "num";
  }
  if (op === "param") {
    if (typeof node.name !== "string" || !params[node.name]) throw new DslError(`unknown param ${node.name}`);
    return "num";
  }
  if (IND_OPS.has(op)) {
    const srcKind = checkExpr(node.src, params, depth + 1);
    if (srcKind !== "num") throw new DslError(`${op} src must be numeric`);
    const p = node.period as Record<string, unknown> & { op?: string };
    if (!p || (p.op !== "const" && p.op !== "param")) throw new DslError(`${op} period must be const or param`);
    checkExpr(p, params, depth + 1);
    return "num";
  }
  if (BIN_OPS.has(op)) {
    if (checkExpr(node.a, params, depth + 1) !== "num" || checkExpr(node.b, params, depth + 1) !== "num") throw new DslError(`${op} operands must be numeric`);
    return "num";
  }
  if (UN_OPS.has(op)) {
    if (checkExpr(node.a, params, depth + 1) !== "num") throw new DslError(`${op} operand must be numeric`);
    return "num";
  }
  if (CMP_OPS.has(op)) {
    if (checkExpr(node.a, params, depth + 1) !== "num" || checkExpr(node.b, params, depth + 1) !== "num") throw new DslError(`${op} operands must be numeric`);
    return "bool";
  }
  if (LOGIC_OPS.has(op)) {
    if (checkExpr(node.a, params, depth + 1) !== "bool" || checkExpr(node.b, params, depth + 1) !== "bool") throw new DslError(`${op} operands must be boolean`);
    return "bool";
  }
  if (op === "not") {
    if (checkExpr(node.a, params, depth + 1) !== "bool") throw new DslError("not operand must be boolean");
    return "bool";
  }
  throw new DslError(`unknown op ${op}`);
}

export function countNodes(e: Expr): number {
  const n = e as unknown as Record<string, unknown>;
  let c = 1;
  for (const k of ["src", "period", "a", "b"]) if (n[k]) c += countNodes(n[k] as Expr);
  return c;
}

export function validateStrategy(doc: StrategyDoc): string[] {
  const errors: string[] = [];
  try {
    const paramNames = Object.keys(doc.params ?? {});
    if (paramNames.length > COMPLEXITY_LIMITS.maxParams) errors.push(`too many params (${paramNames.length})`);
    for (const [k, p] of Object.entries(doc.params ?? {})) {
      if (!(p.min <= p.default && p.default <= p.max)) errors.push(`param ${k}: default outside [min,max]`);
      if (p.max > COMPLEXITY_LIMITS.maxPeriod * 10) errors.push(`param ${k}: max too large`);
    }
    const exprs: [string, Expr | undefined, ExprKind][] = [
      ["longEntry", doc.longEntry, "bool"],
      ["longExit", doc.longExit, "bool"],
      ["shortEntry", doc.shortEntry, "bool"],
      ["shortExit", doc.shortExit, "bool"],
    ];
    let any = false;
    for (const [name, expr, want] of exprs) {
      if (!expr) continue;
      any = true;
      const kind = checkExpr(expr, doc.params ?? {});
      if (kind !== want) errors.push(`${name} must be boolean`);
      const nodes = countNodes(expr);
      if (nodes > COMPLEXITY_LIMITS.maxNodes) errors.push(`${name}: ${nodes} nodes > ${COMPLEXITY_LIMITS.maxNodes}`);
    }
    if (!doc.longEntry || !doc.longExit) errors.push("longEntry and longExit are required");
    if (!!doc.shortEntry !== !!doc.shortExit) errors.push("shortEntry and shortExit must come together");
    if (!any) errors.push("no expressions");
    const r = doc.risk;
    if (!r || !(r.volTargetAnnual > 0 && r.volTargetAnnual <= 1)) errors.push("risk.volTargetAnnual must be in (0,1]");
    if (!r || !(r.maxLeverage > 0 && r.maxLeverage <= 5)) errors.push("risk.maxLeverage must be in (0,5]");
    if (doc.tf !== undefined && !["1h", "4h", "1d"].includes(doc.tf)) errors.push(`tf must be 1h|4h|1d`);
    if (!doc.hypothesis || doc.hypothesis.length < 10) errors.push("hypothesis required (state WHY this should work)");
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return errors;
}

function canon(e: Expr, mode: "exact" | "family", paramOrder: Map<string, number>): string {
  const n = e as unknown as Record<string, unknown> & { op: string };
  switch (n.op) {
    case "price": return `price:${n.field}`;
    case "const": {
      if (mode === "family") return "#";
      const v = n.value as number;
      return `c:${Number(v.toPrecision(3))}`;
    }
    case "param": {
      if (mode === "family") return "P";
      if (!paramOrder.has(n.name as string)) paramOrder.set(n.name as string, paramOrder.size);
      return `p${paramOrder.get(n.name as string)}`;
    }
    default: {
      if (NULLARY_NUM.has(n.op)) return n.op; // funding/basis/oi/... leaf inputs
      const parts: string[] = [];
      for (const k of ["src", "period", "a", "b"]) if (n[k]) parts.push(canon(n[k] as Expr, mode, paramOrder));
      if (COMMUTATIVE.has(n.op) && parts.length === 2) parts.sort();
      return `${n.op}(${parts.join(",")})`;
    }
  }
}

function strategyCanon(doc: StrategyDoc, mode: "exact" | "family"): string {
  const order = new Map<string, number>();
  const parts = [
    canon(doc.longEntry, mode, order),
    canon(doc.longExit, mode, order),
    doc.shortEntry ? canon(doc.shortEntry, mode, order) : "-",
    doc.shortExit ? canon(doc.shortExit, mode, order) : "-",
  ];
  if (mode === "exact") {
    const ps = Object.entries(doc.params ?? {}).map(([k, p]) => {
      const i = order.get(k);
      return i === undefined ? null : `p${i}[${p.min},${p.max}]`;
    }).filter(Boolean).sort();
    parts.push(ps.join(";"));
    parts.push(`risk:${doc.risk.stopAtrMult ?? "-"}/${doc.risk.trailAtrMult ?? "-"}/${doc.risk.volTargetAnnual}/${doc.risk.maxLeverage}`);
    parts.push(`tf:${doc.tf ?? "1h"}`);
  }
  return parts.join("|");
}

export function canonicalHash(doc: StrategyDoc): string {
  return createHash("sha256").update(strategyCanon(doc, "exact")).digest("hex").slice(0, 24);
}

/** structural family hash — ignores constants, param identities, bounds, risk numbers */
export function familyHash(doc: StrategyDoc): string {
  return createHash("sha256").update(strategyCanon(doc, "family")).digest("hex").slice(0, 24);
}

export function defaultParams(doc: StrategyDoc): Record<string, number> {
  return Object.fromEntries(Object.entries(doc.params ?? {}).map(([k, p]) => [k, p.default]));
}
