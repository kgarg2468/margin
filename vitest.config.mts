import { defineConfig } from "vitest/config";

/**
 * Unit tests, and only unit tests.
 *
 * The suite is scoped to `lib/` on purpose: the anchoring module is the one
 * piece of Margin whose correctness cannot be eyeballed in a browser — an
 * anchor that re-resolves onto the wrong sentence looks exactly like one that
 * re-resolves onto the right one until a year of a lab's margins is pointing at
 * the wrong paragraphs. Everything in it is deliberately free of the DOM and of
 * Convex so that it can be tested this cheaply.
 */
export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
});
