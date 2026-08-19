/**
 * Capture the spike's evidence: the same surfaces, at the same moments, in
 * both themes and at both pixel ratios.
 *
 * Timing is the reason this is a script and not a person with a screenshot
 * key. The sweep is a 2.8s event inside a 9s cycle, so "mid-sweep" is a
 * quarter-second window that has to be hit on purpose; the numbers below are
 * read off `lib/scan/sweep.ts` rather than guessed at.
 *
 * Theme is the second reason. Margin defaults to dark and stores the choice
 * in `localStorage`, which a blocking script reads before first paint (see
 * `lib/theme.ts`) — so emulating `prefers-color-scheme: light` proves nothing
 * on its own, because the stored default overrides it. Light shots seed the
 * key; the `auto` shot is the one that exercises the media-query branch.
 *
 *   node docs/spike/capture.mjs [baseUrl]
 */
import { chromium } from "@playwright/test";

const BASE = process.argv[2] ?? "http://localhost:3001";
const OUT = new URL("./", import.meta.url).pathname;

/** From SWEEP_LEAD_IN (1.4s) plus a little under half of SWEEP_DURATION. */
const MID_SWEEP = 2500;
/** Comfortably inside the rest phase of the first cycle. */
const AT_REST = 6000;

const THEME_KEY = "margin-theme";

async function open(browser, { scheme = "dark", dpr = 2, motion = "no-preference", theme }) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: dpr,
    colorScheme: scheme,
    reducedMotion: motion,
  });
  if (theme) {
    await context.addInitScript(
      ([key, value]) => window.localStorage.setItem(key, value),
      [THEME_KEY, theme],
    );
  }
  return context;
}

async function shot(browser, { name, path = "/", wait, before, ...rest }) {
  const context = await open(browser, rest);
  const page = await context.newPage();
  await page.goto(BASE + path, { waitUntil: "load" });
  if (before) {
    await before(page);
  }
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${OUT}${name}.png` });
  await context.close();
  console.log(name);
}

const browser = await chromium.launch();

const shots = [
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

for (const one of shots) {
  await shot(browser, one);
}

await browser.close();
