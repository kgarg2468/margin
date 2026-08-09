/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actions from "../actions.js";
import type * as annotationVersions from "../annotationVersions.js";
import type * as annotations from "../annotations.js";
import type * as auth from "../auth.js";
import type * as briefs from "../briefs.js";
import type * as collections from "../collections.js";
import type * as delegations from "../delegations.js";
import type * as digests from "../digests.js";
import type * as findings from "../findings.js";
import type * as http from "../http.js";
import type * as invites from "../invites.js";
import type * as labs from "../labs.js";
import type * as lib_authz from "../lib/authz.js";
import type * as lib_doi from "../lib/doi.js";
import type * as lib_ledger from "../lib/ledger.js";
import type * as lib_scholarly from "../lib/scholarly.js";
import type * as lib_slack from "../lib/slack.js";
import type * as notifications from "../notifications.js";
import type * as papers from "../papers.js";
import type * as search from "../search.js";
import type * as sessions from "../sessions.js";
import type * as slack from "../slack.js";
import type * as synthesis from "../synthesis.js";
import type * as temporal from "../temporal.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  actions: typeof actions;
  annotationVersions: typeof annotationVersions;
  annotations: typeof annotations;
  auth: typeof auth;
  briefs: typeof briefs;
  collections: typeof collections;
  delegations: typeof delegations;
  digests: typeof digests;
  findings: typeof findings;
  http: typeof http;
  invites: typeof invites;
  labs: typeof labs;
  "lib/authz": typeof lib_authz;
  "lib/doi": typeof lib_doi;
  "lib/ledger": typeof lib_ledger;
  "lib/scholarly": typeof lib_scholarly;
  "lib/slack": typeof lib_slack;
  notifications: typeof notifications;
  papers: typeof papers;
  search: typeof search;
  sessions: typeof sessions;
  slack: typeof slack;
  synthesis: typeof synthesis;
  temporal: typeof temporal;
  users: typeof users;
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
