import { expect, test } from "@playwright/test";
import { chipButtonClass } from "../lib/ui";

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

  /**
   * The bare probe above cannot see the failure this test exists for. `pressable`
   * is a Tailwind *utility*, and the cursor base rules are in the *base* layer —
   * so anything `pressable` says about `cursor` wins on layer order no matter how
   * specific the base rule is, and a disabled control wearing it would promise a
   * press it will not honour. Asserted through the real exported class strings so
   * the test fails if a future edit puts `cursor` back into the utility.
   */
  test("a disabled control keeps not-allowed even wearing the press grammar", async ({
    page,
  }) => {
    await page.goto("/signin");
    const cursors = await page.evaluate((className) => {
      const probe = document.createElement("button");
      probe.className = className;
      probe.disabled = true;
      document.body.appendChild(probe);
      const disabled = getComputedStyle(probe).cursor;

      probe.disabled = false;
      const enabled = getComputedStyle(probe).cursor;

      return { disabled, enabled };
    }, chipButtonClass);

    expect(cursors.disabled).toBe("not-allowed");
    // ...and the affordance is still there when the control is live.
    expect(cursors.enabled).toBe("pointer");
  });

  /**
   * The same invariant swept across a whole page rather than one control. The
   * base layer answers the pointer for every `button` on the document, so a
   * control that comes back with the default cursor is one that a utility has
   * quietly overridden — the "dead button" a user hovers and cannot tell is
   * live. The landing page is the one route with no auth and no backend, which
   * is why it is the page swept.
   */
  test("landing has no dead buttons", async ({ page }) => {
    await page.goto("/");
    for (const el of await page.getByRole("button").all()) {
      if (await el.isVisible()) {
        await expect(el).toHaveCSS("cursor", "pointer");
      }
    }
  });
});

/**
 * Reduced motion, asserted on the effect rather than on the declaration.
 *
 * `pressable` states its `transition` unconditionally and guards only the
 * movement:
 *
 *     transition: … scale var(--dur-press) ease-out;
 *     @media (prefers-reduced-motion: no-preference) {
 *       &:active:not(:disabled) { scale: 0.98; }
 *     }
 *
 * So the computed `transition` still lists `scale 0.06s` under `reduce` — it
 * is a transition with nothing left to animate — and asserting on that string
 * would fail on a correct implementation. What a user with the preference set
 * actually gets is the fact worth pinning: the control does not move when
 * pressed. Driven with a real mouse press because `:active` answers trusted
 * input, not a dispatched `pointerdown`.
 */
test.describe("reduced motion", () => {
  test("a press moves nothing", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/signin");
    const button = page.getByRole("button").first();

    await button.hover();
    await page.mouse.down();
    const pressed = await button.evaluate((el) => getComputedStyle(el).scale);
    // Released off the control so holding it down cannot become a submit.
    await page.mouse.move(0, 0);
    await page.mouse.up();

    expect(pressed).toBe("none");
  });
});
