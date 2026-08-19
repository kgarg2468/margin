/**
 * Capture the spike's evidence: the same surfaces, at the same moments, in
 * both themes and at both pixel ratios.
 *
 * Timing is the reason this is a script and not a person with a screenshot
 * key. The masthead's sweep is a 2.8s event inside a 9s cycle and the shelf's
 * is a 1.15s pass staggered down the list, so "mid-sweep" is a fraction of a
 * second that has to be hit deliberately; the waits below are derived from
 * `lib/scan/sweep.ts` and `lib/scan/scan-sweep.module.css` rather than
 * guessed at. The masthead's clock also starts when its chunk mounts, not
 * when the page loads, which is why the hero shots wait on the canvas.
 *
 * Theme is the second reason. Margin defaults to dark and stores the choice
 * in `localStorage`, which a blocking script reads before first paint (see
 * `lib/theme.ts`) — so emulating `prefers-color-scheme: light` proves nothing
 * on its own, because the stored default overrides it. Light shots seed the
 * key; the `auto` shot is the one that exercises the media-query branch.
 *
 * The shelf shots need a signed-in lab with papers on it, which is a dev
 * deployment and an account, not something a repo can carry. Point
 * SPIKE_AUTH at a Playwright storage state for one and they run; leave it
 * unset and only the marketing surfaces are captured.
 *
 *   node docs/spike/capture.mjs [baseUrl]
 */
import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";

const BASE = process.argv[2] ?? "http://localhost:3001";
const OUT = new URL("./", import.meta.url).pathname;

/** From SWEEP_LEAD_IN (1.4s) plus a little under half of SWEEP_DURATION. */
const MID_SWEEP = 2000;
/** Comfortably inside the rest phase of the first cycle. */
const AT_REST = 6000;
/** Far enough into the shelf's staggered pass to catch the cascade. */
const MID_ROWS = 420;

const THEME_KEY = "margin-theme";
const AUTH = process.env.SPIKE_AUTH ?? "/tmp/spike-auth.json";
const SIGNED_IN = existsSync(AUTH);

async function open(browser, { scheme = "dark", dpr = 2, motion = "no-preference", theme, auth, video }) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: video ? 1 : dpr,
    colorScheme: scheme,
    reducedMotion: motion,
    ...(auth ? { storageState: AUTH } : {}),
    ...(video ? { recordVideo: { dir: `${OUT}.video`, size: { width: 1440, height: 900 } } } : {}),
  });
  if (theme) {
    await context.addInitScript(
      ([key, value]) => window.localStorage.setItem(key, value),
      [THEME_KEY, theme],
    );
  }
  return context;
}

/** The masthead's clock starts with its chunk, so wait for the canvas it makes. */
const heroReady = (page) =>
  page.waitForFunction(() => document.querySelectorAll("canvas").length >= 2, null, {
    timeout: 20000,
  });

/** The shelf's pass starts when the rows do, and the rows wait on Convex. */
const shelfReady = (page) =>
  page.locator("main ul li").first().waitFor({ state: "visible", timeout: 30000 });

async function shot(browser, { name, path = "/", wait, ready, before, ...rest }) {
  const context = await open(browser, rest);
  const page = await context.newPage();
  await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
  if (ready) {
    await ready(page);
  }
  if (before) {
    await before(page);
  }
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${OUT}${name}.png` });
  await context.close();
  console.log(name);
}

const browser = await chromium.launch();

const hero = [
  { name: "hero-dark-rest", theme: "dark", wait: AT_REST },
  { name: "hero-dark-sweep", theme: "dark", wait: MID_SWEEP },
  { name: "hero-light-rest", theme: "light", scheme: "light", wait: AT_REST },
  { name: "hero-light-sweep", theme: "light", scheme: "light", wait: MID_SWEEP },
  // No stored preference and a light system: the media-query branch of the
  // theme grammar, which is the one a hardcoded palette would have broken.
  { name: "hero-auto-light-sweep", theme: "auto", scheme: "light", wait: MID_SWEEP },
  { name: "hero-dark-1x", theme: "dark", dpr: 1, wait: MID_SWEEP },
  { name: "hero-reduced-motion", theme: "dark", motion: "reduce", wait: MID_SWEEP },
];

for (const one of hero) {
  await shot(browser, { ...one, ready: heroReady });
}

if (SIGNED_IN) {
  const shelf = [
    { name: "shelf-dark-sweep", theme: "dark", wait: MID_ROWS },
    { name: "shelf-light-sweep", theme: "light", scheme: "light", wait: MID_ROWS },
    { name: "shelf-dark-settled", theme: "dark", wait: 3000 },
    { name: "shelf-reduced-motion", theme: "dark", motion: "reduce", wait: MID_ROWS },
    {
      name: "shelf-dark-hover",
      theme: "dark",
      wait: 320,
      before: async (page) => {
        await page.waitForTimeout(2600);
        await page.locator("main ul li").nth(2).hover();
      },
    },
  ];
  for (const one of shelf) {
    await shot(browser, { ...one, path: "/app/library", auth: true, ready: shelfReady });
  }
} else {
  console.log("(no SPIKE_AUTH — shelf shots skipped)");
}

/* One take, both surfaces: two sweeps across the masthead, then the shelf
   arriving and a row lit under the pointer. */
{
  await rm(`${OUT}.video`, { recursive: true, force: true });
  const context = await open(browser, { theme: "dark", video: true, auth: SIGNED_IN });
  const page = await context.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await heroReady(page);
  await page.waitForTimeout(12500);
  if (SIGNED_IN) {
    await page.goto(BASE + "/app/library", { waitUntil: "domcontentloaded" });
    await shelfReady(page);
    await page.waitForTimeout(2200);
    for (const row of [1, 3]) {
      await page.locator("main ul li").nth(row).hover();
      await page.waitForTimeout(1400);
    }
  }
  const video = page.video();
  await context.close();
  if (video) {
    await rename(await video.path(), `${OUT}scan.webm`);
  }
  await rm(`${OUT}.video`, { recursive: true, force: true });
  console.log("scan.webm");
}

await browser.close();
