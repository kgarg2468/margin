# A4 — Shell & Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the reader an explicit theme preference (auto / light / dark, default dark) that is decided before first paint, stop the digest inbox from materialising in the middle of the lab home page after it has settled, and re-shoot the README so its figures show the product that A1–A3 actually shipped.

**Architecture:** Theming is already entirely CSS — `app/globals.css` resolves every token through `light-dark()` keyed on the used `color-scheme`, and emits `.light` / `.dark` overrides on `:root` plus a `prefers-color-scheme` rule for the no-class case. So a preference is one string in `localStorage` and one class on `<html>`; a blocking inline script in the root layout applies it before paint, and a small control in the sidebar rewrites it. No provider, no context, no cookie — a cookie would have to be read in the root layout, which would opt `(marketing)` out of the build-time prerender it is deliberately kept eligible for. The digest fix is a three-state slot: the inbox reserves a line-height ghost until *both* its subscription and its mount-time `catchUp` mutation have answered, and it moves from mid-page to directly under the lab header.

**Tech Stack:** Next.js 15 (app router, Turbopack), React 19, Tailwind v4 with Lightning CSS, Convex + convex-helpers cached hooks, Vitest (node environment, `.ts` only), Playwright (backend-free, built app).

## Global Constraints

Binding house rules. Every task's requirements implicitly include all of these.

- UI is built from the shared classes in `lib/ui.ts` (`chipClass`, `labelClass`, `skeletonClass`, …), never ad-hoc colour or shadow literals.
- Interactive elements use the pressable press grammar: the `pressable` utility, feedback on **pointerdown** not click, compositor-only transforms (`scale` / `opacity`).
- `useQuery` is imported from `convex-helpers/react/cache/hooks`, never from `convex/react`. This is eslint-enforced.
- Comments carry reasoning — why this and not the obvious alternative. Never restate what the code says.
- No pricing or monetization content anywhere, in code, copy, or docs.
- Ledger events are recorded only via `recordEvent()`.
- Every commit message ends with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Never push to `main`; never run `convex deploy`.

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/theme.ts` (create) | The preference type, its storage key, its default, the class it maps to, and the boot-script source built from those same constants. Pure TypeScript, no React, no DOM at module scope. |
| `lib/theme.test.ts` (create) | Runs the boot script against stub globals; covers every stored value plus a throwing storage. |
| `app/layout.tsx` (modify) | Inlines the boot script in `<head>` so the class lands before the first paint. |
| `app/(app)/app/_components/theme-toggle.tsx` (create) | The three-option control. Reads storage in an effect, writes on press, swaps the class on `<html>`. |
| `app/(app)/app/_components/sidebar.tsx` (modify) | Mounts the toggle in the rail footer beside the account. |
| `e2e/feel.spec.ts` (modify) | Asserts default-dark on a light-preferring browser, and that the decision is in the served HTML rather than in an effect. |
| `app/(app)/app/_components/digest-state.ts` (create) | `inboxState()` — the three-way decision the inbox draws from. Plain TS core beside its component, per `vitest.config.mts`. |
| `app/(app)/app/_components/digest-state.test.ts` (create) | Covers the state that did not previously exist: resolved-but-still-asking. |
| `app/(app)/app/_components/digest.tsx` (modify) | Reserves the slot; tracks whether `catchUp` has answered; same slot-holding for the session prep digest. |
| `app/(app)/app/_components/lab-overview.tsx` (modify) | Moves the inbox from between the calendar and the roster to directly under the header. |
| `README.md` + `docs/assets/screenshots/*.png` (modify) | Four re-shot figures and the prose that describes them. |

---

## Task 1: Theme preference core and the pre-paint boot script

**Files:**
- Create: `lib/theme.ts`
- Create: `lib/theme.test.ts`
- Modify: `app/layout.tsx:62-72`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type ThemePreference = "auto" | "light" | "dark"`
  - `const DEFAULT_THEME: ThemePreference` (value `"dark"`)
  - `const THEME_STORAGE_KEY: string` (value `"margin-theme"`)
  - `readPreference(raw: string | null): ThemePreference`
  - `themeClass(preference: ThemePreference): "light" | "dark" | null`
  - `const THEME_BOOT_SCRIPT: string`

**Background the implementer needs:** `app/globals.css` already does all the theming. Line 199 sets `color-scheme: light dark` on `:root`; lines 221-233 add `:root:not(.light)` under `prefers-color-scheme: dark`, plus `.light { color-scheme: light }` and `.dark { color-scheme: dark }`. Every semantic token is a `light-dark()` pair that resolves off the used `color-scheme`. Lightning CSS lowers those pairs to toggle custom properties and emits them for exactly `:root`, `.light` and `.dark` — which is why the class must go on `<html>` (it is `:root`) and nowhere else. The `dark:` Tailwind variant is wired to match (`@custom-variant dark`, lines 8-17). `<html>` already carries `suppressHydrationWarning` (`app/layout.tsx:68`).

- [ ] **Step 1: Write the failing test**

Create `lib/theme.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  readPreference,
  themeClass,
} from "./theme";

/**
 * The boot script is the only code in the product that runs before React, so
 * it is the only code that cannot be checked by rendering something. It is a
 * string, though, and a string is testable: run it against a stand-in document
 * and a stand-in storage, then read back what it put on the class list.
 *
 * `new Function` rather than `eval` so the script cannot reach this file's
 * scope by accident. It gets exactly the two globals it is allowed to see,
 * which doubles as an assertion that it does not quietly need a third.
 */
function boot(stored: string | null | (() => never)): string[] {
  const classes: string[] = [];
  const documentStub = {
    documentElement: {
      classList: {
        add: (name: string) => {
          classes.push(name);
        },
      },
    },
  };
  const localStorageStub = {
    getItem: (key: string) => {
      if (key !== THEME_STORAGE_KEY) {
        throw new Error(`the script read the wrong key: ${key}`);
      }
      return typeof stored === "function" ? stored() : stored;
    },
  };
  new Function("document", "localStorage", THEME_BOOT_SCRIPT)(
    documentStub,
    localStorageStub,
  );
  return classes;
}

describe("the boot script", () => {
  it("is dark on a first visit, whatever the system asks for", () => {
    expect(boot(null)).toEqual(["dark"]);
  });

  it("honours a stored light", () => {
    expect(boot("light")).toEqual(["light"]);
  });

  it("honours a stored dark", () => {
    expect(boot("dark")).toEqual(["dark"]);
  });

  it("sets no class for auto, leaving the media query to decide", () => {
    // Not a matchMedia read: `:root:not(.light)` under `prefers-color-scheme`
    // already follows the system live, so "auto" is the absence of an opinion
    // rather than a snapshot of one — and it keeps following after dusk with
    // nothing listening.
    expect(boot("auto")).toEqual([]);
  });

  it("falls back to the default on an entry it does not recognise", () => {
    expect(boot("midnight")).toEqual([DEFAULT_THEME]);
  });

  it("still themes the page when storage throws outright", () => {
    // `localStorage` throws, not returns null, in a partitioned iframe or with
    // site data blocked. A theme is never worth a blank page.
    expect(
      boot(() => {
        throw new Error("site data blocked");
      }),
    ).toEqual([DEFAULT_THEME]);
  });

  it("cannot drift from the module's own key", () => {
    expect(THEME_BOOT_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });
});

describe("readPreference", () => {
  it("passes the three real answers through", () => {
    expect(readPreference("auto")).toBe("auto");
    expect(readPreference("light")).toBe("light");
    expect(readPreference("dark")).toBe("dark");
  });

  it("treats absent and corrupt the same way", () => {
    expect(readPreference(null)).toBe(DEFAULT_THEME);
    expect(readPreference("")).toBe(DEFAULT_THEME);
    expect(readPreference("Dark")).toBe(DEFAULT_THEME);
  });
});

describe("themeClass", () => {
  it("names the class for a forced theme and nothing for auto", () => {
    expect(themeClass("light")).toBe("light");
    expect(themeClass("dark")).toBe("dark");
    expect(themeClass("auto")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run lib/theme.test.ts`
Expected: FAIL — `Failed to resolve import "./theme"`.

- [ ] **Step 3: Write the module**

Create `lib/theme.ts`:

```ts
/**
 * Which theme the product is in, and how that is decided before first paint.
 *
 * `app/globals.css` already answers to a class on <html>: `.light` and `.dark`
 * force a `color-scheme`, and no class at all leaves `prefers-color-scheme` to
 * decide. So a preference is one string in storage and one class name, and
 * everything below it is CSS that already exists.
 *
 * Two choices worth stating, because the obvious alternatives are both wrong
 * here:
 *
 * Storage is `localStorage`, not a cookie. A cookie would have to be read in
 * the root layout, and reading the request in the root layout opts the whole
 * tree out of static rendering — including `(marketing)`, which is prerendered
 * at build time on purpose (see the note on `RootLayout`).
 *
 * The class is applied by a blocking script, not by an effect. An effect runs
 * after the first paint, so a dark-preferring reader would see one frame of
 * sand before it corrected itself. That flash is the entire reason this file
 * is a string of JavaScript rather than a hook.
 */
export type ThemePreference = "auto" | "light" | "dark";

/**
 * Absent or unreadable storage means dark — the register the product is
 * written in, and the one the README has always claimed. Following the system
 * by default is what made a light-appearance laptop show a light Margin.
 */
export const DEFAULT_THEME: ThemePreference = "dark";

export const THEME_STORAGE_KEY = "margin-theme";

const PREFERENCES: readonly string[] = ["auto", "light", "dark"];

/**
 * A stored string, read as a preference. Anything that is not one of the three
 * — absent, truncated, left by an older build — resolves to the default rather
 * than raising: a corrupt entry should cost the reader a theme they can change
 * back, not a page that will not render.
 */
export function readPreference(raw: string | null): ThemePreference {
  return raw !== null && PREFERENCES.includes(raw)
    ? (raw as ThemePreference)
    : DEFAULT_THEME;
}

/**
 * The class <html> should wear. `auto` wears none: the media query in
 * `globals.css` is what follows the system, it follows it live, and so there
 * is nothing to listen to and nothing to re-apply when the machine flips at
 * dusk.
 */
export function themeClass(
  preference: ThemePreference,
): "light" | "dark" | null {
  return preference === "auto" ? null : preference;
}

/**
 * The script that runs before the first paint.
 *
 * Assembled from the constants above rather than written out, so a renamed key
 * or a changed default cannot leave the script saying one thing and the module
 * another — the class of bug that would only show as a flash on a stranger's
 * machine.
 *
 * Synchronous and inlined in <head>: it blocks parsing for the microsecond it
 * takes to read one storage key, which is the price of not painting the wrong
 * page. The catch falls back to the default class rather than doing nothing,
 * because storage being unavailable is not the reader asking to follow their
 * system.
 */
export const THEME_BOOT_SCRIPT = [
  "(function(){",
  `var d=${JSON.stringify(themeClass(DEFAULT_THEME) ?? "")};`,
  "try{",
  `var p=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});`,
  'var c=p==="light"||p==="dark"?p:p==="auto"?"":d;',
  "if(c)document.documentElement.classList.add(c);",
  "}catch(e){if(d)document.documentElement.classList.add(d)}",
  "})()",
].join("");
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run lib/theme.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Inline the script in the root layout**

In `app/layout.tsx`, add the import beside the existing ones:

```ts
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
```

Then replace the returned markup (currently `app/layout.tsx:62-72`) with:

```tsx
  return (
    // The font variables live on <html> so `--font-serif` (declared on :root
    // in globals.css) can resolve them; on <body> they would be out of scope.
    // The theme class lands on the same element for the same kind of reason:
    // Lightning CSS emits the `light-dark()` toggles for `:root`, `.light` and
    // `.dark` and for nothing else, so <html> is the only element where a
    // class can move a token.
    <html
      lang="en"
      className={`${sourceSerif.variable} ${inter.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/*
         * Before anything paints, and before React exists. `suppressHydration-
         * Warning` above is what lets the server's classless <html> and the
         * client's themed one agree — the class is not React's to know about.
         */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
```

- [ ] **Step 6: Verify the app still builds and types check**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/theme.ts lib/theme.test.ts app/layout.tsx
git commit -m "$(cat <<'EOF'
Theme: the page decides what it is before it paints

localStorage plus a blocking inline script, because a cookie read in the
root layout would cost `(marketing)` its build-time prerender and an effect
would paint sand at a dark-preferring reader for one frame.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: The toggle in the rail, and the browser assertion that it is dark by default

**Files:**
- Create: `app/(app)/app/_components/theme-toggle.tsx`
- Modify: `app/(app)/app/_components/sidebar.tsx:107-140`
- Modify: `e2e/feel.spec.ts` (append a describe block)

**Interfaces:**
- Consumes: `ThemePreference`, `DEFAULT_THEME`, `THEME_STORAGE_KEY`, `readPreference`, `themeClass` from `@/lib/theme` (Task 1).
- Produces: `ThemeToggle()` — a zero-prop client component.

**House pattern to follow:** `app/(app)/app/library/[paperId]/read/_components/visibility-toggle.tsx` is the existing segmented control — `role="radiogroup"` wrapping `role="radio"` buttons with `aria-checked`, `inline-flex self-start overflow-hidden rounded-sm border border-rule`, selected option in `bg-accent text-accent-contrast`. Mirror it, and add the press grammar it predates.

- [ ] **Step 1: Write the component**

Create `app/(app)/app/_components/theme-toggle.tsx`:

```tsx
"use client";

import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  readPreference,
  themeClass,
  type ThemePreference,
} from "@/lib/theme";
import { labelClass } from "@/lib/ui";
import { useEffect, useState } from "react";

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * Three words in the rail's footer, beside the account.
 *
 * State starts at the default and is corrected in an effect rather than read
 * during render: `localStorage` does not exist on the server, and rendering
 * the stored answer on the client would be a hydration mismatch on the one
 * control whose whole job is to say which theme you are in. The *page* is
 * never wrong in the meantime — the boot script in `app/layout.tsx` put the
 * class on <html> before anything painted — only this control's own marked
 * option, and only for a frame.
 *
 * Applying a choice is a class swap on <html> and a write to storage, in that
 * order: the swap is what the reader sees and costs one style recalculation,
 * the write is only what the next visit reads. No context and no provider,
 * because there is exactly one consumer of this state and it is CSS.
 */
export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(DEFAULT_THEME);

  useEffect(() => {
    setPreference(
      readPreference(window.localStorage.getItem(THEME_STORAGE_KEY)),
    );
  }, []);

  function apply(next: ThemePreference) {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    const className = themeClass(next);
    if (className !== null) {
      root.classList.add(className);
    }
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Site data can be blocked. The theme still changes for this visit; it
      // simply will not be remembered, which is the better half to lose.
    }
    setPreference(next);
  }

  return (
    <div className="flex flex-col gap-2">
      <span id="theme-label" className={labelClass}>
        Theme
      </span>
      <div
        role="radiogroup"
        aria-labelledby="theme-label"
        className="inline-flex self-start overflow-hidden rounded-sm border border-rule"
      >
        {OPTIONS.map((option) => {
          const selected = option.value === preference;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              // pointerdown, not click: the press grammar acknowledges within
              // a frame, and a class swap has nothing to wait for. Enter and
              // Space never fire a pointer event, so the keyboard is handled
              // below rather than left to a click that would arrive twice.
              onPointerDown={() => apply(option.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  apply(option.value);
                }
              }}
              className={
                "pressable px-2.5 py-1 font-sans text-[11px] uppercase tracking-[0.12em] " +
                (selected
                  ? "bg-accent text-accent-contrast"
                  : "text-ink-faint hover:text-ink-muted")
              }
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount it in the sidebar**

In `app/(app)/app/_components/sidebar.tsx`, add the import beside the other local ones:

```ts
import { ThemeToggle } from "./theme-toggle";
```

Then replace the footer block (currently `sidebar.tsx:107-140`, opening `<div className="mt-auto flex flex-col gap-2 border-t border-rule pt-5">`) with:

```tsx
      {/* The footer is where the reader's own settings live rather than the
          lab's: how the page looks to them, who they are on it, and the way
          out. None of the three is about the paper. */}
      <div className="mt-auto flex flex-col gap-4 border-t border-rule pt-5">
        <ThemeToggle />

        <div className="flex flex-col gap-2">
          {viewer !== undefined && viewer !== null && (
            <span className="truncate font-sans text-sm text-ink-muted">
              {viewer.name ?? viewer.email}
            </span>
          )}
          {/*
            A document navigation, not `router.push` — the one place in the app
            where throwing the JS context away is the point.

            `clearAuth()` only tells the server to stop trusting us; it does not
            clear the client's stored query results. Everything still subscribed
            re-runs without an identity, `requireUserId` throws, and those
            failures sit in the client-global result store keyed by query token.
            The query cache holds those tokens subscribed for five minutes after
            the last unmount, so `QueryRemoved` never fires and the failures
            outlive the session — and the cached `useQuery` rethrows a stored
            Error during render. Signing back in would then read a dead session's
            errors. A full load destroys the client singleton, the result store
            and every pending eviction timer, so the next session starts every
            query at `undefined`. One page load at a session boundary costs
            nothing: there is nothing worth keeping warm across it.
          */}
          <button
            type="button"
            className={`${linkButtonClass} self-start`}
            onClick={async () => {
              await signOut();
              window.location.assign("/signin");
            }}
          >
            Sign out
          </button>
        </div>
      </div>
```

- [ ] **Step 3: Write the browser assertions**

Append to `e2e/feel.spec.ts`:

```ts
/**
 * The theme, asserted where it is actually decided.
 *
 * Playwright's context asks for `prefers-color-scheme: light` unless told
 * otherwise, which is exactly the condition the old behaviour got wrong: the
 * product followed the system, so a light laptop got a light Margin and the
 * README's "dark mode throughout" was false on half the machines that opened
 * it. The assertion is the used page colour rather than a class name — the
 * class is only how it is done.
 *
 * `/signin` and not `/app`: this suite runs with no backend on purpose (see
 * `playwright.config.ts`), and the sign-in page is a real page rendered by the
 * same root layout.
 */
test.describe("theme", () => {
  test.use({ colorScheme: "light" });

  test("a first visit is dark even when the system asks for light", async ({
    page,
  }) => {
    await page.goto("/signin");
    const background = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    // --page, dark branch: #16110e.
    expect(background).toBe("rgb(22, 17, 14)");
  });

  test("the decision is in the served HTML, not in an effect", async ({
    request,
  }) => {
    // The no-flash guarantee, stated as the only thing that can prove it: the
    // script is in the document React hydrates into, so the class is on <html>
    // before React has run at all.
    const html = await (await request.get("/signin")).text();
    expect(html).toContain("margin-theme");
    expect(html).toContain("classList.add");
  });
});
```

- [ ] **Step 4: Run the browser suite**

Run: `npm run test:e2e`
Expected: PASS, including the two new tests. (The config builds and starts the app itself; first run takes a couple of minutes.)

- [ ] **Step 5: Lint and typecheck**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/\(app\)/app/_components/theme-toggle.tsx app/\(app\)/app/_components/sidebar.tsx e2e/feel.spec.ts
git commit -m "$(cat <<'EOF'
Theme: three words in the rail, and dark is the one that means nothing was asked

Auto follows the system, light and dark force it, and the default is dark
whatever the machine says. The browser test asserts it on a light-preferring
context, which is the case that was wrong before.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: The digest holds its slot, and stops sitting mid-page

**Files:**
- Create: `app/(app)/app/_components/digest-state.ts`
- Create: `app/(app)/app/_components/digest-state.test.ts`
- Modify: `app/(app)/app/_components/digest.tsx:55-85` and `:94-168`
- Modify: `app/(app)/app/_components/lab-overview.tsx:43-81`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `type InboxState = "reserving" | "empty" | "showing"` and `inboxState({ loaded, catchUpSettled, unreadCount }): InboxState` — used only by `digest.tsx`.

**The bug, precisely.** `DigestInbox` is mounted at `lab-overview.tsx:60`, between `NextSession` (`:59`) and `Members` (`:62`) — the middle of the page. It has two late paths and reserves space for neither:

1. `digest.tsx:98-100` reads `(digests ?? []).filter(...)`, so while the subscription is in flight it renders nothing at all. Every sibling section on that page renders a ghost instead (`lab-overview.tsx:101`, `:161`, `:437`); the inbox is the only one that does not.
2. `digest.tsx:111-117` fires `catchUp` on mount, and `catchUp` can *build* a since-away digest server-side. So even after the query has resolved empty and the page has settled, a card can arrive a full round trip later and shove the roster, the invite codes and the Slack section down the page under the reader's cursor.

The fix is both halves: a reserved ghost until both paths have answered, and a move to directly under the header so the section is not mid-page in the first place.

- [ ] **Step 1: Write the failing test**

Create `app/(app)/app/_components/digest-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { inboxState } from "./digest-state";

describe("inboxState", () => {
  it("reserves the slot while the subscription is still out", () => {
    expect(
      inboxState({ loaded: false, catchUpSettled: true, unreadCount: 0 }),
    ).toBe("reserving");
  });

  it("keeps reserving after the query lands, until catchUp has answered", () => {
    // The whole reason this is three states and not two. `digests` resolving
    // to an empty list used to mean "no mail" — but `catchUp` was still out,
    // and it is a mutation that can *build* a digest. The section rendered
    // nothing, the page settled, and then a card appeared mid-read.
    expect(
      inboxState({ loaded: true, catchUpSettled: false, unreadCount: 0 }),
    ).toBe("reserving");
  });

  it("is empty only once both paths have answered", () => {
    expect(
      inboxState({ loaded: true, catchUpSettled: true, unreadCount: 0 }),
    ).toBe("empty");
  });

  it("shows mail that has already arrived without waiting for the mutation", () => {
    // A card in hand fills the slot either way, so holding a ghost over it
    // would only delay something the reader can already act on.
    expect(
      inboxState({ loaded: true, catchUpSettled: false, unreadCount: 2 }),
    ).toBe("showing");
  });

  it("never goes back to reserving once it has shown", () => {
    // Both inputs latch true, so the only transition out of "showing" is to
    // "empty" — which is the fold-away, and is animated.
    expect(
      inboxState({ loaded: true, catchUpSettled: true, unreadCount: 1 }),
    ).toBe("showing");
    expect(
      inboxState({ loaded: true, catchUpSettled: true, unreadCount: 0 }),
    ).toBe("empty");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run "app/(app)/app/_components/digest-state.test.ts"`
Expected: FAIL — `Failed to resolve import "./digest-state"`.

- [ ] **Step 3: Write the core**

Create `app/(app)/app/_components/digest-state.ts`:

```ts
/**
 * What the inbox should be drawing, given what it currently knows.
 *
 * Three states, and the third is the point. A digest arrives by two different
 * late paths — the subscription resolving, and the `catchUp` mutation the
 * inbox fires on mount, which can build a since-away card a round trip after
 * the page has settled. So "there is no mail" and "nobody has answered yet"
 * are different facts and have to be drawn differently. Conflating them is
 * what put a card into the middle of the lab's home page after the reader had
 * already started reading it.
 *
 * `reserving` holds the slot with the same line-height ghost the roster and
 * the calendar beside it use, until both paths have answered. The page then
 * composes itself once.
 */
export type InboxState = "reserving" | "empty" | "showing";

export function inboxState({
  loaded,
  catchUpSettled,
  unreadCount,
}: {
  loaded: boolean;
  catchUpSettled: boolean;
  unreadCount: number;
}): InboxState {
  if (unreadCount > 0) {
    return "showing";
  }
  return loaded && catchUpSettled ? "empty" : "reserving";
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run "app/(app)/app/_components/digest-state.test.ts"`
Expected: PASS — 5 tests.

- [ ] **Step 5: Wire the inbox to it**

In `app/(app)/app/_components/digest.tsx`:

Widen the `lib/ui` import (currently line 7) to pull in the ghost:

```ts
import { errorClass, eyebrowClass, skeletonClass } from "@/lib/ui";
```

Add the core beside the other local import (`./errors`, line 14):

```ts
import { inboxState } from "./digest-state";
```

Replace the mount effect and everything after it in `DigestInbox` (currently `digest.tsx:102-167`) with:

```tsx
  // Arriving is the boundary. Nothing on the server can know a member was away
  // until they turn up — Margin keeps no last-active stamp to poll, by
  // constitution — so the mount is the trigger, and `catchUp` decides. Almost
  // every call decides nothing: it is idempotent, it never stacks a second
  // card, and it never moves a cursor. The ref keeps a re-render from asking
  // twice, and a failure clears it again: a lab's home page must not turn into
  // an error because a digest could not be built, but nor should one dropped
  // request cost the member their digest for the whole visit.
  //
  // `settled` is separate from the ref because it is about the page rather
  // than about the request: until this comes back, the section does not yet
  // know whether it exists, and it holds a slot rather than guessing empty.
  const asked = useRef<string | null>(null);
  const [catchUpSettled, setCatchUpSettled] = useState(false);
  useEffect(() => {
    if (asked.current === labId) return;
    asked.current = labId;
    setCatchUpSettled(false);
    void catchUp({ labId })
      .catch(() => {
        if (asked.current === labId) asked.current = null;
      })
      .finally(() => {
        setCatchUpSettled(true);
      });
  }, [labId, catchUp]);

  const state = inboxState({
    loaded: digests !== undefined,
    catchUpSettled,
    unreadCount: unread.length,
  });

  // The reserved slot: one line, the same ghost the roster and the calendar
  // use, sized to nothing in particular because a heading over an unknown is
  // worse than a blank. Returning before the presence below is safe precisely
  // because both of its inputs latch — nothing ever comes back here, so no
  // exit animation is being cut short.
  if (state === "reserving") {
    return (
      <span
        aria-label="Loading"
        role="status"
        className={`${skeletonClass} h-6 w-56`}
      />
    );
  }

  // "Caught up" is a put-away, and it should read as one: the acknowledged
  // card folds closed and the page settles, instead of everything below it
  // snapping up a card-height. The outer presence does the same for the
  // whole section when the last card goes. `AnimatePresence` stays mounted
  // through the empty state, or there would be nothing to run the exit.
  return (
    <AnimatePresence initial={false}>
      {unread.length > 0 && (
        <motion.section
          key="inbox"
          exit={
            reduce === true
              ? { opacity: 0, transition: { duration: 0 } }
              : { opacity: 0, height: 0, transition: { duration: 0.28 } }
          }
          style={{ overflow: "hidden" }}
          className="flex flex-col gap-4"
        >
          <h2 className={eyebrowClass}>Since you were away</h2>
          <p className="max-w-prose font-sans text-xs text-ink-faint">
            Delivered at a boundary — before a session, as it starts, and when
            you come back after time away — never on every write. Only you see
            this.
          </p>
          <div className="flex flex-col gap-6">
            <AnimatePresence initial={false}>
              {unread.map((digest) => (
                <motion.div
                  key={digest._id}
                  layout={reduce !== true}
                  exit={
                    reduce === true
                      ? { opacity: 0, transition: { duration: 0 } }
                      : {
                          opacity: 0,
                          scale: 0.985,
                          transition: { duration: 0.2 },
                        }
                  }
                >
                  <DigestCard digest={digest} labId={labId} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
```

- [ ] **Step 6: Give the session prep digest the same slot**

Still in `digest.tsx`, replace the body of `SessionDigest` above its `return` (currently `digest.tsx:62-69`) with:

```tsx
  const digests = useQuery(api.digests.listMine, { labId });
  const mine = (digests ?? []).filter(
    (digest) => digest.sessionId === sessionId,
  );

  // The same slot-holding as the inbox, minus the mutation: nothing on this
  // page builds a prep digest, so the subscription is the only late path. It
  // sits between the presenter's brief and the manage panel, which is as
  // mid-page as it gets — a card appearing here after the page settled would
  // push the meeting's controls out from under a cursor already on them.
  if (digests === undefined) {
    return (
      <span
        aria-label="Loading"
        role="status"
        className={`${skeletonClass} h-6 w-56`}
      />
    );
  }

  // Renders nothing at all once the answer is in and it is "none": a session
  // scheduled for next week has no prep yet, and an empty "Your prep" heading
  // over a blank box is worse than the absence of one.
  if (mine.length === 0) {
    return null;
  }
```

Delete the sentence about rendering nothing from the doc block above `SessionDigest` (`digest.tsx:48-54`), since it now lives beside the branch it describes. The doc block becomes:

```tsx
/**
 * The prep digest for one session — the personal half of a session page.
 */
```

- [ ] **Step 7: Move the inbox out of the middle of the page**

In `app/(app)/app/_components/lab-overview.tsx`, replace lines 59-60 (`<NextSession lab={lab} />` and `<DigestInbox labId={lab._id} />`) with the two in the other order:

```tsx
      {/* Mail first, and above everything it could otherwise have appeared in
          the middle of. What changed since the reader last looked is the whole
          reason the page is different from the last time they saw it; the
          calendar and the roster are the same as they were. */}
      <DigestInbox labId={lab._id} />

      <NextSession lab={lab} />
```

- [ ] **Step 8: Run the full unit suite, lint and types**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: PASS, no errors.

- [ ] **Step 9: Commit**

```bash
git add app/\(app\)/app/_components/digest-state.ts app/\(app\)/app/_components/digest-state.test.ts app/\(app\)/app/_components/digest.tsx app/\(app\)/app/_components/lab-overview.tsx
git commit -m "$(cat <<'EOF'
Digest: the slot is held, and the mail is read first

`catchUp` can build a card a round trip after the page settled, so an empty
query was never the same fact as no mail. Three states, a reserved ghost
until both paths answer, and the inbox moves out from between the calendar
and the roster to under the header.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Re-shoot the README so its figures are the shipped product

**Files:**
- Modify: `docs/assets/screenshots/reader.png`
- Modify: `docs/assets/screenshots/composer.png`
- Modify: `docs/assets/screenshots/session-live.png`
- Modify: `docs/assets/screenshots/synthesis.png`
- Modify: `README.md:34` (the dark-mode sentence) and the alt text on the four replaced figures
- Leave alone: `docs/assets/screenshots/landing-dark.png`, `docs/assets/brand/margin-wordmark.png`

**Interfaces:**
- Consumes: Tasks 1-3 are all merged before this runs — the shots must show the theme toggle in the rail and the digest in its new position.
- Produces: nothing code depends on.

**Why these four and not the fifth.** All five current shots were committed together in `d9f78ce` on 2026-08-08, before the entire feel overhaul. `git log d9f78ce..HEAD -- "app/(marketing)"` is empty, so **`landing-dark.png` still matches the marketing page exactly** and stays. The other four are provably stale, and each has a visible tell:

- **`reader.png`** — the rail's notes are not aligned to their passages (A1's anchoring), the header has no zoom or page-jump controls (they exist now at `reader.tsx:1205`, `:1256`, `:1284`), and the sidebar predates ⌘K search, the notification rail and collections (`sidebar.tsx:59`, `:65`, `:105`).
- **`composer.png`** — the composer sits unflipped in the middle of the viewport with the selection unlit; A1 shipped flip/shift, a selection that stays lit while composing, and ⌘↵.
- **`session-live.png`** — the board quotes still carry PDF line-break debris ("are subse- quently transferred"), and the type-distribution bar is four equal segments with labels that do not line up under them. A2 fixed both.
- **`synthesis.png`** — every citation group restarts at "Note 1". That is literally the bug A2 fixed with stable per-note numbering; the figure is a picture of the defect.

**Prerequisites before capturing anything.** There is no seed script in the repo. The shots are taken against `npm run dev` pointed at the dev Convex deployment in `.env.local`, signed in as a member of the demo lab the existing figures show (Computational Memory Lab; Elena Whitfield and Marcus Feld). Confirm that deployment still holds:

- the paper `10.1371/journal.pcbi.1009681` ("Hebbian plasticity in parallel synaptic pathways") with its per-page text layer,
- at least six lab-visible typed annotations on it, spanning at least four of the six types, written by both members, several of them clustered on adjacent passages of the abstract so the rail has a collision to relax,
- one session on that paper that has been started and ended,
- a generated synthesis on that session, with at least two paragraphs citing three or more distinct notes.

If any of it is gone, rebuild it through the UI before capturing — DOI ingest, annotate as both members, schedule a session inside its start window, start it, end it, generate the write-up. Do not add a seed script for this; that is a separate piece of work.

**Capture settings.** Viewport 1440×900 at `deviceScaleFactor: 2`, matching the existing files (2880×1800). The synthesis figure is cropped to its column — the existing file is 2080×1760, and the README renders it at `width="72%"`. Clear the `margin-theme` key in the capture profile so the shot is taken on the shipped default rather than on whatever the operator last picked; the pages must render dark.

- [ ] **Step 1: Verify the demo data is present**

Start the dev server (`npm run dev`), sign in, and walk the four screens listed above. Note anything missing and rebuild it before continuing. Do not capture against half-populated data — a board with one card is not what the caption claims.

- [ ] **Step 2: Capture `reader.png`**

Screen: `/app/library/<paperId>/read` on the Hebbian paper.
State: scrolled so a run of three or more typed notes is visible in the rail, each aligned to its own passage; one note hovered so its type-coloured connector to the highlight is drawn; the filter-chip strip showing per-type counts; the zoom and page-jump controls visible in the header; the sidebar showing search, notifications and collections.
This is the flagship figure — it is the one that has to show anchoring, which is the thing A1 was for.

- [ ] **Step 3: Capture `composer.png`**

Screen: same reader.
State: a text selection made in the **lower third** of the viewport, so the composer flips above it and is fully on screen — the old shot's failure is exactly that it is not. The selection stays lit under the open composer; a note type is chosen; the visibility toggle and the ⌘↵ hint are both readable.

- [ ] **Step 4: Capture `session-live.png`**

Screen: `/app/sessions/<sessionId>` with the session live.
State: the type-distribution bar showing proportions that match the counts beside it; the passage board carrying at least four quotes across three types from both members, every quote ending at a sentence boundary with no `[nn]` markers and no hyphenation debris; the End-session control in the header.

- [ ] **Step 5: Capture `synthesis.png`**

Screen: the same session after ending, showing the generated write-up.
State: cropped to the write-up column. At least two paragraphs must be visible whose citations run `Note 1`, `Note 2`, `Note 3` and continue across paragraphs rather than restarting — that continuity is the proof the figure exists to carry.

- [ ] **Step 6: Update the README prose that the theme toggle made untrue**

`README.md:34` currently reads:

```markdown
The product stays in its warm brown dark mode throughout:
```

Replace with:

```markdown
The product opens in its warm brown dark mode and stays there unless you say otherwise — the rail carries an auto/light/dark switch, and dark is what a first visit gets whatever the machine underneath asks for:
```

- [ ] **Step 7: Check the alt text still describes the picture**

Re-read the five `alt` attributes and the five captions in `README.md:38-62` against the new files. The claims that must now be true rather than aspirational: Fig. 2's "anchored passages and the typed margin rail", Fig. 4's "populated typed passage board", Fig. 5's "attribution and citations". Fix any wording the new shots contradict. Fig. 1 and its caption are unchanged.

- [ ] **Step 8: Confirm the figures render**

Run: `git status --short docs/assets/screenshots` and confirm exactly four modified files and no new ones. Open `README.md` in a Markdown preview and check all six images resolve and none has grown past a couple of megabytes.

- [ ] **Step 9: Commit**

```bash
git add README.md docs/assets/screenshots
git commit -m "$(cat <<'EOF'
README: the figures are the product again

Four shots predated the feel overhaul and showed its bugs — an unanchored
rail, a composer off the bottom of the screen, hyphenation debris in the
board quotes, and a write-up whose citations restart at Note 1 in every
paragraph. The landing shot is untouched; the marketing page has not moved.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage** — TIMELINE line 32 has three clauses:

| Clause | Tasks |
| --- | --- |
| Theme toggle (auto/light/dark, default dark) replacing the wall-clock switch | 1 (preference + pre-paint decision), 2 (control + browser assertion) |
| Digest placement fixed (nothing pops in mid-page) | 3 (reserved slot for both late paths, both digest surfaces, moved above the fold) |
| README screenshot regeneration to match shipped reality | 4 (four re-shot figures, one kept, prose corrected) |

**Type consistency** — `ThemePreference`, `DEFAULT_THEME`, `THEME_STORAGE_KEY`, `readPreference`, `themeClass`, `THEME_BOOT_SCRIPT` are defined in Task 1 and used under those exact names in Task 2. `inboxState` and `InboxState` are defined and consumed inside Task 3. Nothing in Task 4 references a symbol.

**Known limitation, deliberately not fixed here:** `app/layout.tsx:44-49` declares `viewport.themeColor` as two entries keyed on `prefers-color-scheme`, so a light-appearance machine on the forced dark default reports a sand-coloured browser chrome against a dark page. Correcting it means mutating Next's generated `<meta>` tags from the boot script, which is a bigger and uglier change than the mismatch it fixes. Flagged rather than done.
