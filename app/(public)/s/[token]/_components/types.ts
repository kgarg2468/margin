import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

/**
 * The public view model, taken from the query rather than restated.
 *
 * Every field a share page can draw is one `shares.view` decided to hand over,
 * and deriving these types from it is what stops the two from drifting: a
 * field the backend stops returning becomes a type error here rather than an
 * `undefined` rendered as a blank line.
 */
type SharedArtifact = NonNullable<FunctionReturnType<typeof api.shares.view>>;

export type SharedPaperView = Extract<SharedArtifact, { kind: "paper" }>;
export type SharedSynthesisView = Extract<SharedArtifact, { kind: "synthesis" }>;
export type SharedNote = SharedPaperView["notes"][number];
