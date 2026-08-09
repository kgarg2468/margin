import path from "node:path";
import { fileURLToPath } from "node:url";
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
 *
 * `app/` is here for the same reason and with the same restraint: only `.ts`,
 * never `.tsx`. Some client modules keep a plain-TypeScript core beside the
 * hook that uses it — the rule a component is built on, with no React in it —
 * and that core is testable in `node` without pulling in a DOM. A test that
 * needed to render would belong in `e2e/`, against the real app.
 *
 * Those cores still sit in a file that imports its React neighbours, though,
 * and the import graph is loaded whole. So JSX has to be transformable even
 * though nothing here renders any: `tsconfig.json` sets `jsx: "preserve"` for
 * Next's own compiler, which leaves Vite's transform staring at angle brackets
 * it was told not to touch. `automatic` is the same runtime Next uses, applied
 * only to the test run.
 *
 * `@/` is resolved here too. Next understands the tsconfig `paths` alias, Vite
 * does not, and a shared module that imports `@/lib/...` should not have to
 * know which one is loading it.
 */
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": path.dirname(fileURLToPath(import.meta.url)),
    },
  },
  test: {
    include: ["lib/**/*.test.ts", "convex/**/*.test.ts", "app/**/*.test.ts"],
    environment: "node",
  },
});
