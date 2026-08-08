import { expect, test } from "@playwright/test";

/**
 * The press grammar, asserted on the built app rather than on the source.
 *
 * These are the two facts a user feels within the first second: a control
 * answers the pointer, and it gives under the finger fast (60ms) while its
 * colours ease slowly (150ms). Both live in `app/globals.css` — a base layer
 * and the `pressable` utility — so nothing but a rendered page can confirm
 * them survived Tailwind's cascade. The transition is asserted property by
 * property on purpose: `transition: all` is the failure mode worth catching,
 * because it drags layout properties onto the main thread and the press stops
 * being compositor-only.
 */

test.describe("press feel", () => {
  test("buttons acknowledge the pointer", async ({ page }) => {
    await page.goto("/signin");
    const button = page.getByRole("button").first();
    await expect(button).toHaveCSS("cursor", "pointer");
    // scale transitions in 60ms, colors in 150ms — never `all`
    const transition = await button.evaluate(
      (el) => getComputedStyle(el).transition,
    );
    expect(transition).toContain("scale 0.06s");
    expect(transition).toContain("background-color 0.15s");
    expect(transition).not.toContain("all");
  });

  test("disabled controls say so", async ({ page }) => {
    await page.goto("/signin");
    const cursor = await page.evaluate(() => {
      const probe = document.createElement("button");
      probe.disabled = true;
      document.body.appendChild(probe);
      return getComputedStyle(probe).cursor;
    });
    expect(cursor).toBe("not-allowed");
  });
});
