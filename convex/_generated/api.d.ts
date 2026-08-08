/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import type * as annotations from "../annotations.js";
import type * as auth from "../auth.js";
import type * as digests from "../digests.js";
import type * as http from "../http.js";
import type * as invites from "../invites.js";
import type * as labs from "../labs.js";
import type * as lib_authz from "../lib/authz.js";
import type * as lib_doi from "../lib/doi.js";
import type * as lib_ledger from "../lib/ledger.js";
import type * as lib_scholarly from "../lib/scholarly.js";
import type * as papers from "../papers.js";
import type * as sessions from "../sessions.js";
import type * as users from "../users.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  annotations: typeof annotations;
  auth: typeof auth;
  digests: typeof digests;
  http: typeof http;
  invites: typeof invites;
  labs: typeof labs;
  "lib/authz": typeof lib_authz;
  "lib/doi": typeof lib_doi;
  "lib/ledger": typeof lib_ledger;
  "lib/scholarly": typeof lib_scholarly;
  papers: typeof papers;
  sessions: typeof sessions;
  users: typeof users;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
