/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as book from "../book.js";
import type * as candidates from "../candidates.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as ledger from "../ledger.js";
import type * as live from "../live.js";
import type * as paper from "../paper.js";
import type * as pipeline from "../pipeline.js";
import type * as premium from "../premium.js";
import type * as promotions from "../promotions.js";
import type * as signalIc from "../signalIc.js";
import type * as summaries from "../summaries.js";
import type * as watch from "../watch.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  book: typeof book;
  candidates: typeof candidates;
  crons: typeof crons;
  dashboard: typeof dashboard;
  ledger: typeof ledger;
  live: typeof live;
  paper: typeof paper;
  pipeline: typeof pipeline;
  premium: typeof premium;
  promotions: typeof promotions;
  signalIc: typeof signalIc;
  summaries: typeof summaries;
  watch: typeof watch;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
