import { defineConfig, devices } from "@playwright/test";

/**
 * Backend-free browser smoke.
 *
 * The suite exists because of a bug that shipped: the middleware matcher
 * dropped `/api/auth`, every sign-in 404'd in production, and CI was green the
 * whole time — lint, tsc, unit tests and `next build` all pass on an app whose
 * routing is broken, because none of them ever ask the built app a question
 * over HTTP. These tests do.
 *
 * Deliberately no Convex backend. `NEXT_PUBLIC_CONVEX_URL` points at a
 * hostname that does not resolve, which is the honest CI condition and also a
 * real assertion: the landing page must render without a backend, and the
 * routing facts below (405/400 on `/api/auth`, the `/app` → `/signin`
 * redirect) are all decided by `middleware.ts` before Convex is ever reached.
 * Nothing here logs in or reads data — a test that needs a deployment is a
 * test that will be flaky, skipped, then deleted.
 */

const PORT = 3123;
const HOST = "localhost";

export const BASE_URL = `http://${HOST}:${PORT}`;

/** Resolvable-looking, unreachable. See the note above. */
const PLACEHOLDER_CONVEX_URL = "https://ci-placeholder.convex.cloud";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,

  // No retries, in CI or out. Every assertion here is about a deterministic
  // response from a server with no network dependencies; a test that only
  // passes on the second try is reporting a real bug, and retrying would hide
  // exactly the class of intermittent routing failure this suite is for.
  retries: 0,

  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 15_000,
  expect: { timeout: 5_000 },

  // Traces are written under `coverage/`, which the repo already ignores, so a
  // failed local run cannot leave a multi-megabyte zip staged for commit.
  outputDir: "coverage/playwright",

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    // Builds *and* starts, rather than assuming an earlier `npm run build`.
    //
    // `NEXT_PUBLIC_*` is inlined into the client bundle at build time, so a
    // build that ran without `NEXT_PUBLIC_CONVEX_URL` produces an app whose
    // /signin throws on load no matter what the server's environment says
    // later. Owning both halves here is what keeps the artifact under test and
    // the environment it was built for from ever disagreeing — and one command
    // is the whole local gate.
    //
    // `next start`, not `next dev`: dev bundles different code and does not
    // exercise the middleware the way a deployment will.
    command: `npm run build && npx next start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { NEXT_PUBLIC_CONVEX_URL: PLACEHOLDER_CONVEX_URL },
  },
});
