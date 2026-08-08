import { expect, test } from "@playwright/test";
import { BASE_URL } from "../playwright.config";

/**
 * The four things that have to be true of the built app before it is worth
 * deploying, asked over HTTP against `next start` with no Convex backend
 * running. See `playwright.config.ts` for why there is deliberately no
 * backend here.
 *
 * Everything below is decided by the Next.js artifact and `middleware.ts`
 * alone. Nothing signs in, nothing reads data, nothing waits on a socket —
 * so a failure is a routing or rendering regression, never a flake.
 */

/** Anything that names the unreachable placeholder deployment, or Convex itself. */
const isConvexNoise = (message: string) =>
  /convex/i.test(message) || /ci-placeholder/.test(message);

test.describe("/ — the landing page", () => {
  test("renders without a backend and without console errors", async ({
    page,
  }) => {
    const errors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText ?? "";
      // `next/link` prefetches `/signin` as soon as the CTA scrolls into view;
      // whichever of those is still in flight when the test closes the page is
      // cancelled by the browser. An abort is us, not the server — counting it
      // would make this test fail on timing, which is the one thing a smoke
      // test must never do.
      if (reason.includes("ERR_ABORTED")) return;
      errors.push(`requestfailed: ${request.url()} ${reason}`);
    });

    const response = await page.goto("/");
    expect(response?.status()).toBe(200);

    // Scoped to <main>: the same tagline is repeated in the footer, and a
    // hero that failed to render while the footer survived is exactly the
    // failure worth catching.
    const hero = page.locator("main");
    await expect(hero.getByRole("heading", { level: 1 })).toHaveText("margin");
    await expect(
      hero.getByText("The collective intelligence layer for research groups."),
    ).toBeVisible();
    // `?flow=signup` is load-bearing, not decoration: the CTA promises an
    // account, and without it `/signin` opens on "Pick up where your lab left
    // off" and a sign-in form — the returning-user state, contradicting the
    // button that was just pressed.
    //
    // The page repeats the CTA on purpose — same label, same destination, top
    // and bottom — so this asserts over every instance rather than picking
    // one: a second button that drifted to a different href is exactly the
    // inconsistency worth failing on.
    const ctas = hero.getByRole("link", { name: "Start a journal club" });
    expect(await ctas.count()).toBeGreaterThanOrEqual(1);
    for (const cta of await ctas.all()) {
      await expect(cta).toHaveAttribute("href", "/signin?flow=signup");
    }

    // The landing page lives in the `(marketing)` route group precisely so it
    // mounts no Convex provider and prerenders to a static file. If this
    // partition is ever non-empty, the marketing page has quietly acquired a
    // backend dependency — it will still "work" in dev with a deployment
    // running, and cost every visitor a round trip to Convex in production.
    const convexNoise = errors.filter(isConvexNoise);
    expect(
      convexNoise,
      "The landing page must render with no backend at all.",
    ).toEqual([]);

    expect(errors).toEqual([]);
  });
});

test.describe("/signin", () => {
  test("renders the credential form", async ({ page }) => {
    const crashes: string[] = [];
    page.on("pageerror", (error) => crashes.push(error.message));

    const response = await page.goto("/signin");
    expect(response?.status()).toBe(200);

    // `ConvexReactClient` is constructed at module scope and throws if
    // `NEXT_PUBLIC_CONVEX_URL` is missing — and because `NEXT_PUBLIC_*` is
    // inlined at *build* time, a build that ran without it ships a /signin
    // that is dead on arrival however the server is configured afterwards.
    // Called out by name because the symptom otherwise is "the email field is
    // not visible", which sends you looking at the form.
    expect(
      crashes.filter((message) => message.includes("NEXT_PUBLIC_CONVEX_URL")),
      "The app was built without NEXT_PUBLIC_CONVEX_URL, so the client bundle throws before /signin renders.",
    ).toEqual([]);

    // The form is the only part of `/signin` that does not need a deployment,
    // and it is the part a broken build takes out first.
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });
});

test.describe("/api/auth — the Convex Auth endpoint", () => {
  /**
   * THIS IS THE REGRESSION TEST FOR THE PRODUCTION AUTH OUTAGE.
   *
   * Convex Auth ships no route file: `/api/auth` is served by `middleware.ts`,
   * so it exists only if the middleware `matcher` in that file lists it. It
   * once did not, every sign-in and sign-up 404'd on the first production
   * deploy, and CI was green — lint, tsc, unit tests and `next build` are all
   * blind to a matcher entry, because nothing in them asks the built app for a
   * URL.
   *
   * The assertion is therefore about *reachability*, not about a happy path:
   * with no backend, a reached endpoint answers 4xx/5xx from the auth handler.
   * A 404 means the handler is not mounted at all. Do not "fix" a failure here
   * by loosening it to `< 500` — check `config.matcher` in `middleware.ts`.
   */
  test("is mounted (a 404 here is the bug that broke production)", async ({
    request,
  }) => {
    const get = await request.get("/api/auth", { maxRedirects: 0 });
    expect(
      get.status(),
      "GET /api/auth should be rejected by the auth handler, not missing",
    ).toBe(405);

    const post = await request.post("/api/auth", {
      data: {},
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(
      post.status(),
      "POST /api/auth returned 404: the middleware matcher has dropped /api/auth and sign-in is broken",
    ).not.toBe(404);
    expect(post.status()).toBeGreaterThanOrEqual(400);
  });
});

test.describe("/app — protected routes", () => {
  test("redirects an unauthenticated visitor to /signin", async ({
    page,
    request,
  }) => {
    // Header-level first: this is the middleware's own answer, before any
    // client-side navigation could paper over a missing redirect.
    const response = await request.get("/app", { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    // Next.js sends this absolute in some paths and root-relative in others;
    // resolving against the request URL makes the assertion about the
    // destination rather than about which form we happened to get.
    const location = new URL(response.headers().location ?? "", BASE_URL);
    expect(location.pathname).toBe("/signin");

    // And end to end, since a redirect to a page that cannot render is not a
    // redirect anyone benefits from.
    await page.goto("/app");
    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.getByLabel("Email")).toBeVisible();
  });
});
