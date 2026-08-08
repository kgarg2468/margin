import { defineConfig } from "vitest/config";

/**
 * Unit tests, and only unit tests.
 *
 * The suite covers the modules whose correctness cannot be eyeballed in a
 * browser. Anchoring is the original case: an anchor that re-resolves onto the
 * wrong sentence looks exactly like one that re-resolves onto the right one
 * until a year of a lab's margins is pointing at the wrong paragraphs. The
 * digest engine is the second, and the synthesis sanitizer the third — it is
 * the only thing standing between a model's output and the database, and a
 * mis-attributed quote is just as invisible and just as expensive.
 *
 * `convex/` is included for that last one. Convex's own bundler skips any file
 * with more than one dot in its name, so a `*.test.ts` next to the module it
 * tests is never pushed as a deployed function.
 */
export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts", "convex/**/*.test.ts"],
    environment: "node",
  },
});
