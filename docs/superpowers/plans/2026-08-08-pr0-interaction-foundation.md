# PR 0 — Interaction Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the app-wide interaction layer — press feel, motion tokens, skeletons, toasts, optimistic-mutation helper, popover/dialog/select primitives, ⌘K shell, sticky sidebar — that every subsequent per-screen PR builds on.

**Architecture:** CSS utilities + tokens live in `app/globals.css`; shared class strings in `lib/ui.ts`; shared React primitives in `app/(app)/app/_components/`. New dependency: `@base-ui-components/react` (headless, unstyled, includes Floating-UI positioning) styled entirely with existing tokens. Pure logic (fuzzy matcher) lives in `lib/` with Vitest tests.

**Tech Stack:** Next.js 15 App Router, React 19, Tailwind v4 (CSS-first config in globals.css), Convex 1.43 (`useMutation().withOptimisticUpdate`), Base UI, Vitest, Playwright 1.62.

## Global Constraints (from the spec — every task inherits these)

- Press: starts on pointerdown (CSS `:active`), `scale(0.98)`, **60ms** in; compositor properties only (`scale`, `translate`, `opacity` — never layout/paint, never `transition: all`).
- Hover: **150ms**, color/alpha only. Enter: **180ms** `cubic-bezier(0.16, 1, 0.3, 1)`. Exit: **120ms**. Keyboard-triggered surfaces: no entrance animation.
- `prefers-reduced-motion`: movement drops, color transitions stay (existing `motion-safe:` grammar).
- All colors via semantic tokens (`bg-surface`, `text-ink-muted`, `var(--note-*)`) — never raw hex in components.
- Chrome is `font-sans`; anything read/written is `font-serif` (existing grammar in `lib/ui.ts`).
- No pricing/money content anywhere.
- Never push to main. Branch: `kgarg2468/notion-like-ux-polish` (already exists, has the spec commit). Small commits, push after each task.
- Verification per task: `npm run lint && npx tsc --noEmit && npm run test` must pass before each commit (run `npm run test:e2e` where the task touches e2e).

**Reference reading for any implementer:** `docs/superpowers/specs/2026-08-08-product-feel-overhaul-design.md` (the contract), `.context/research/code-audit.md` (file:line evidence), `.context/design-demo/margin-feel.html` (the approved feel, self-contained HTML).

---

### Task 1: Motion tokens, cursor base layer, and the 60ms press grammar

**Files:**
- Modify: `app/globals.css` (tokens + base layer + utilities, after the `@theme inline` block)
- Modify: `lib/ui.ts:17-20` (the `pressable` constant), plus add `chipButtonClass`
- Test: `e2e/feel.spec.ts` (new — runs against public `/signin`, no backend needed)

**Interfaces:**
- Produces: CSS utilities `pressable`, custom properties `--dur-press: 60ms`, `--dur-hover: 150ms`, `--dur-enter: 180ms`, `--dur-exit: 120ms`, `--ease-settle: cubic-bezier(0.16, 1, 0.3, 1)`. `lib/ui.ts` exports unchanged in name (`primaryButtonClass`, `secondaryButtonClass`, `chipClass`) plus new `chipButtonClass` (chip that is a real control). Later tasks reference all of these.

- [ ] **Step 1: Write the failing e2e test**

```ts
// e2e/feel.spec.ts
import { expect, test } from "@playwright/test";

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
```

- [ ] **Step 2: Run it, verify it fails** — `npm run test:e2e -- feel.spec.ts` → FAIL (`cursor` is `default`).

- [ ] **Step 3: Add tokens + base layer to `app/globals.css`** (motion tokens go inside the existing `:root` block; base rules in a new `@layer base` after the theme mapping):

```css
:root {
  /* ...existing tokens... */

  /* --- motion budget (see docs/superpowers/specs/2026-08-08-...) ----
   * press 60 / hover 150 / enter 180 / exit 120. Compositor properties
   * only; the press must render at native refresh regardless of what
   * the main thread is doing. */
  --dur-press: 60ms;
  --dur-hover: 150ms;
  --dur-enter: 180ms;
  --dur-exit: 120ms;
  --ease-settle: cubic-bezier(0.16, 1, 0.3, 1);
}

/* Tailwind v4 preflight leaves buttons with the UA's default cursor.
 * A control that doesn't answer the pointer reads as broken. */
@layer base {
  button:not(:disabled),
  [role="button"]:not([aria-disabled="true"]),
  select:not(:disabled),
  summary,
  label[for] {
    cursor: pointer;
  }
  button:disabled,
  select:disabled {
    cursor: not-allowed;
  }
}

/* The press grammar: colors ease at hover speed, the control gives
 * under the finger at press speed. `scale` is compositor-animated. */
@utility pressable {
  cursor: pointer;
  user-select: none;
  transition:
    color var(--dur-hover) ease-out,
    background-color var(--dur-hover) ease-out,
    border-color var(--dur-hover) ease-out,
    opacity var(--dur-hover) ease-out,
    scale var(--dur-press) ease-out;
  @media (prefers-reduced-motion: no-preference) {
    &:active:not(:disabled) {
      scale: 0.98;
    }
  }
}
```

- [ ] **Step 4: Rewrite `pressable` in `lib/ui.ts`** — replace lines 17-20 with a reference to the utility, and add the interactive chip:

```ts
/** The press grammar every control shares — see `@utility pressable`. */
const pressable = "pressable";
```

(The two button classes keep interpolating `${pressable}`; delete the old `motion-safe:transition-...` string.) Then below `chipClass`:

```ts
/** A chip that is a real control (filter chips, type toggles). */
export const chipButtonClass = `${chipClass} ${pressable} hover:border-ink-faint hover:text-ink-muted`;
```

- [ ] **Step 5: Run the e2e test, verify it passes** — `npm run test:e2e -- feel.spec.ts` → PASS. Also `npm run lint && npx tsc --noEmit && npm run test`.

- [ ] **Step 6: Visual sanity** — `npm run dev`, open `/signin`, click the submit button: it should dip 2% for 60ms on mousedown. Verify the landing page buttons unaffected visually otherwise.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feel: 60ms press grammar, cursor base layer, motion tokens"` and push.

---

### Task 2: Shimmer skeletons and route-level loading states

**Files:**
- Modify: `app/globals.css` (replace `margin-breathe` usage with shimmer utility; keep the keyframe for compat until callers migrate)
- Modify: `lib/ui.ts:73-75` (`skeletonClass`)
- Read first: `app/(app)/app/_components/skeletons.tsx` (existing shaped skeletons — reuse, don't duplicate)
- Create: `app/(app)/app/loading.tsx`, `app/(app)/app/library/loading.tsx`, `app/(app)/app/sessions/loading.tsx`, `app/(app)/app/library/[paperId]/loading.tsx`, `app/(app)/app/sessions/[sessionId]/loading.tsx`

**Interfaces:**
- Consumes: `skeletonClass` from Task 1's `lib/ui.ts` (unchanged export name).
- Produces: `skeletonClass` now renders a shimmer (research: shimmer reads as shorter wait than pulse). `loading.tsx` per route renders the same shapes `skeletons.tsx` already defines, so route transitions paint a skeleton instantly instead of a blank `main`.

- [ ] **Step 1: Add the shimmer utility to `app/globals.css`** (near `margin-breathe`):

```css
/* A sheen passing over what-is-coming. Transform-only (compositor);
 * reduced motion falls back to the static sunken block. */
@keyframes margin-shimmer {
  to {
    translate: 100% 0;
  }
}

@utility skeleton-shimmer {
  position: relative;
  overflow: hidden;
  &::after {
    content: "";
    position: absolute;
    inset: 0;
    translate: -100% 0;
    background: linear-gradient(
      90deg,
      transparent,
      color-mix(in oklab, var(--ink) 5%, transparent),
      transparent
    );
    @media (prefers-reduced-motion: no-preference) {
      animation: margin-shimmer 1.6s var(--ease-settle) infinite;
    }
  }
}
```

- [ ] **Step 2: Point `skeletonClass` at it** in `lib/ui.ts`:

```ts
export const skeletonClass = "rounded-sm bg-surface-sunken skeleton-shimmer";
```

- [ ] **Step 3: Create the five `loading.tsx` files.** Each is a server component that renders the existing shaped skeletons. First read `app/(app)/app/_components/skeletons.tsx` and reuse its exports; if a route has no matching shape there, compose from `skeletonClass` directly, e.g.:

```tsx
// app/(app)/app/library/loading.tsx
import { skeletonClass } from "@/lib/ui";

export default function LibraryLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy>
      <div className={`${skeletonClass} h-8 w-44`} />
      {[0, 1, 2].map((i) => (
        <div key={i} className={`${skeletonClass} h-24 w-full`} />
      ))}
    </div>
  );
}
```

Match each screen's real layout (title row + list) so the resolve is single-paint with no shift. Reader route (`library/[paperId]/loading.tsx`): a page-shaped block (`aspect-[8.5/11] max-w-[40rem]`) beside a rail column.

- [ ] **Step 4: Verify** — `npm run lint && npx tsc --noEmit && npm run test && npm run test:e2e`. In `npm run dev`, throttle network (dev tools) and click Library → Sessions: skeleton appears instantly, no blank flash.

- [ ] **Step 5: Commit** — `git commit -m "feel: shimmer skeletons + route-level loading states"` and push.

---

### Task 3: Navigation feel — staleTimes and prefetch

**Files:**
- Modify: `next.config.ts`
- Modify: `app/(app)/app/_components/sidebar.tsx` (nav `Link`s)

**Interfaces:**
- Consumes: nothing new. Produces: client router cache so back/forward and repeat nav are instant; sidebar links prefetch.

- [ ] **Step 1: Configure `next.config.ts`:**

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Dynamic routes default to staleTime 0 — every nav refetches.
    // 30s keeps within-session hops instant; Convex live queries keep
    // the data itself fresh once mounted.
    staleTimes: { dynamic: 30, static: 180 },
  },
};

export default nextConfig;
```

- [ ] **Step 2: Prefetch the two nav links** — in `sidebar.tsx`, add `prefetch={true}` to the section `<Link>`s (dynamic routes only prefetch their loading boundary by default; explicit `prefetch` warms it on viewport rather than hover-only).

- [ ] **Step 3: Verify** — `npm run build` succeeds (config key is valid on Next 15.5); dev-mode nav Library ↔ Sessions twice — second visit paints without skeleton.

- [ ] **Step 4: Commit** — `git commit -m "feel: router staleTimes + nav prefetch"` and push.

---

### Task 4: Sticky sidebar

**Files:**
- Modify: `app/(app)/app/_components/sidebar.tsx:26`

**Interfaces:** none new.

- [ ] **Step 1: Fix the aside classes.** The audit measured the sidebar as `h-screen` + `position: static` — on a 2570px page the nav scrolls away and leaves a tonal seam. Change line 26 to:

```tsx
<aside className="flex shrink-0 flex-col gap-8 border-b border-rule bg-surface-sunken px-6 py-6 md:sticky md:top-0 md:h-screen md:w-64 md:self-start md:overflow-y-auto md:border-b-0 md:border-r md:py-8">
```

(`md:sticky md:top-0 md:self-start` keeps it pinned; `md:overflow-y-auto` guards short viewports. The parent flex in `app/(app)/app/layout.tsx` needs no change — `items-stretch` is the default, and the sticky element scrolls within its full-height flex column, so the sunken surface runs the page's full height and the seam disappears.)

- [ ] **Step 2: Verify** — dev mode, open a long page (Sessions with several rows or Library), scroll to bottom: nav stays pinned, left column color unbroken. Check `md` breakpoint and mobile (unchanged stacked layout).

- [ ] **Step 3: Commit** — `git commit -m "feel: sidebar stays pinned on long pages"` and push.

---

### Task 5: Toast + undo layer

**Files:**
- Create: `app/(app)/app/_components/toast.tsx`
- Modify: `app/(app)/app/layout.tsx` (mount provider)
- Create: `lib/toast-store.ts` (pure queue logic)
- Test: `lib/toast-store.test.ts`

**Interfaces:**
- Consumes: `panelClass`-style tokens, `--dur-enter`/`--dur-exit`, `pressable` from Task 1.
- Produces (later tasks and PRs depend on these exact names):
  - `lib/toast-store.ts`: `createToastStore()` returning `{ push(toast: ToastInput): number; dismiss(id: number): void; subscribe(fn: (toasts: Toast[]) => void): () => void }` with `type ToastInput = { message: string; tone?: "default" | "error"; action?: { label: string; onAction: () => void }; durationMs?: number }` and `type Toast = ToastInput & { id: number }`. Default duration 5000ms; error tone 8000ms; max 3 visible (oldest dropped).
  - `toast.tsx`: `ToastProvider` (client component wrapping children) and `useToast(): (input: ToastInput) => void`.

- [ ] **Step 1: Write failing tests for the store:**

```ts
// lib/toast-store.test.ts
import { describe, expect, it, vi } from "vitest";
import { createToastStore } from "./toast-store";

describe("toast store", () => {
  it("pushes and notifies subscribers", () => {
    const store = createToastStore();
    const seen: unknown[] = [];
    store.subscribe((toasts) => seen.push(toasts.map((t) => t.message)));
    store.push({ message: "Saved" });
    expect(seen.at(-1)).toEqual(["Saved"]);
  });

  it("dismisses by id", () => {
    const store = createToastStore();
    const id = store.push({ message: "One" });
    store.dismiss(id);
    let current: unknown;
    store.subscribe((toasts) => (current = toasts));
    expect(current).toEqual([]);
  });

  it("caps visible toasts at three, dropping the oldest", () => {
    const store = createToastStore();
    ["a", "b", "c", "d"].forEach((message) => store.push({ message }));
    let current: { message: string }[] = [];
    store.subscribe((toasts) => (current = toasts));
    expect(current.map((t) => t.message)).toEqual(["b", "c", "d"]);
  });

  it("auto-dismisses after the tone's duration", () => {
    vi.useFakeTimers();
    const store = createToastStore();
    store.push({ message: "gone", tone: "default" });
    vi.advanceTimersByTime(5001);
    let current: unknown[] = [{}];
    store.subscribe((toasts) => (current = toasts));
    expect(current).toEqual([]);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npm run test -- toast-store` → module not found.

- [ ] **Step 3: Implement `lib/toast-store.ts`:**

```ts
export type ToastInput = {
  message: string;
  tone?: "default" | "error";
  action?: { label: string; onAction: () => void };
  durationMs?: number;
};
export type Toast = ToastInput & { id: number };

const DURATION: Record<"default" | "error", number> = {
  default: 5000,
  error: 8000,
};
const MAX_VISIBLE = 3;

export function createToastStore() {
  let toasts: Toast[] = [];
  let nextId = 1;
  const listeners = new Set<(toasts: Toast[]) => void>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  const emit = () => listeners.forEach((fn) => fn(toasts));

  const dismiss = (id: number) => {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  };

  const push = (input: ToastInput) => {
    const id = nextId++;
    toasts = [...toasts, { ...input, id }].slice(-MAX_VISIBLE);
    const ms = input.durationMs ?? DURATION[input.tone ?? "default"];
    timers.set(id, setTimeout(() => dismiss(id), ms));
    emit();
    return id;
  };

  return {
    push,
    dismiss,
    subscribe(fn: (toasts: Toast[]) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
```

- [ ] **Step 4: Run tests, verify pass** — `npm run test -- toast-store`.

- [ ] **Step 5: Build `toast.tsx`** — client component: context holding a memoized store, `useSyncExternalStore` for the list, fixed stack `bottom-6 right-6 z-50`, each toast a `font-sans text-sm` surface card (`border border-rule bg-surface shadow-[var(--shadow-sheet)] rounded-md px-4 py-3`), error tone gets the `errorClass` left-rule treatment, action button uses `linkButtonClass`, dismiss ✕ uses `pressable`. Entrance `pop-in`; exit: 120ms opacity via a `data-leaving` attribute before removal. `role="status"` (`role="alert"` for error tone). Mount `<ToastProvider>` inside `LabProvider` in `app/(app)/app/layout.tsx` wrapping `children` — note the layout is a server component, so `ToastProvider` must carry `"use client"`.

- [ ] **Step 6: Verify** — lint/types/tests green; temporary dev-only trigger removed before commit.

- [ ] **Step 7: Commit** — `git commit -m "feel: toast + undo layer"` and push.

---

### Task 6: Optimistic mutation helper with visible rollback

**Files:**
- Create: `app/(app)/app/_components/use-feedback-mutation.ts`
- Test: `app/(app)/app/_components/use-feedback-mutation.test.ts` (pure logic part)

**Interfaces:**
- Consumes: `useToast` from Task 5.
- Produces: `useFeedbackMutation(mutation, opts)` — exact shape:

```ts
function useFeedbackMutation<M extends FunctionReference<"mutation">>(
  mutation: M,
  opts: {
    optimisticUpdate?: OptimisticUpdate<FunctionArgs<M>>;
    errorMessage: string; // human copy, e.g. "Couldn't save your note"
    onRolledBack?: () => void; // restore drafts, reopen composers
  },
): (args: FunctionArgs<M>) => Promise<FunctionReturnType<M> | undefined>;
```

Behavior: applies `optimisticUpdate` via Convex's `.withOptimisticUpdate` (Convex auto-rolls-back `localStore` on error — the helper's job is making the rollback *visible*); on rejection it toasts `errorMessage` with tone `error` and calls `onRolledBack`, returning `undefined` instead of throwing. Callers never `await`-block their UI on the promise.

- [ ] **Step 1: Write the failing test for the wrapper logic** (extract the catch-and-report core as a pure function so it tests without React):

```ts
// app/(app)/app/_components/use-feedback-mutation.test.ts
import { describe, expect, it, vi } from "vitest";
import { runWithFeedback } from "./use-feedback-mutation";

describe("runWithFeedback", () => {
  it("returns the mutation result on success and stays silent", async () => {
    const toast = vi.fn();
    const result = await runWithFeedback(
      () => Promise.resolve("id123"),
      { errorMessage: "Couldn't save", toast },
    );
    expect(result).toBe("id123");
    expect(toast).not.toHaveBeenCalled();
  });

  it("toasts and reports rollback on failure instead of throwing", async () => {
    const toast = vi.fn();
    const onRolledBack = vi.fn();
    const result = await runWithFeedback(
      () => Promise.reject(new Error("server")),
      { errorMessage: "Couldn't save", toast, onRolledBack },
    );
    expect(result).toBeUndefined();
    expect(onRolledBack).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith({
      message: "Couldn't save",
      tone: "error",
    });
  });
});
```

- [ ] **Step 2: Run, verify fail.** `npm run test -- use-feedback-mutation`

- [ ] **Step 3: Implement:**

```ts
// app/(app)/app/_components/use-feedback-mutation.ts
"use client";

import { useMutation } from "convex/react";
import type { OptimisticUpdate } from "convex/browser";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import { useCallback } from "react";
import type { ToastInput } from "@/lib/toast-store";
import { useToast } from "./toast";

/** Exported for tests: the catch-and-report core, free of React. */
export async function runWithFeedback<T>(
  run: () => Promise<T>,
  opts: {
    errorMessage: string;
    toast: (input: ToastInput) => void;
    onRolledBack?: () => void;
  },
): Promise<T | undefined> {
  try {
    return await run();
  } catch {
    opts.onRolledBack?.();
    opts.toast({ message: opts.errorMessage, tone: "error" });
    return undefined;
  }
}

export function useFeedbackMutation<
  M extends FunctionReference<"mutation">,
>(
  mutation: M,
  opts: {
    optimisticUpdate?: OptimisticUpdate<FunctionArgs<M>>;
    errorMessage: string;
    onRolledBack?: () => void;
  },
) {
  const toast = useToast();
  const base = useMutation(mutation);
  const withOptimistic = opts.optimisticUpdate
    ? base.withOptimisticUpdate(opts.optimisticUpdate)
    : base;

  return useCallback(
    (args: FunctionArgs<M>): Promise<FunctionReturnType<M> | undefined> =>
      runWithFeedback(() => withOptimistic(args), {
        errorMessage: opts.errorMessage,
        toast,
        onRolledBack: opts.onRolledBack,
      }),
    [withOptimistic, toast, opts.errorMessage, opts.onRolledBack],
  );
}
```

(If `OptimisticUpdate`'s import path or generic arity differs on convex 1.43, check `node_modules/convex/dist/esm-types/browser/index.d.ts` and match it — the *call* pattern `useMutation(...).withOptimisticUpdate(fn)` is the stable API. Never mutate `localStore` values in place — always write new objects.)

- [ ] **Step 4: Run tests, verify pass; lint + types.**

- [ ] **Step 5: Commit** — `git commit -m "feel: optimistic mutation helper with visible rollback"` and push.

---

### Task 7: Base UI primitives — popover, confirm dialog, styled select

**Files:**
- Modify: `package.json` (add `@base-ui-components/react`, latest 1.x)
- Create: `app/(app)/app/_components/popover.tsx`
- Modify: `app/(app)/app/_components/confirm-action.tsx` (rebuild on Base UI AlertDialog, keep its exported API — read it first)
- Create: `app/(app)/app/_components/select.tsx`
- Modify: `app/(app)/app/_components/sidebar.tsx` (lab switcher uses the new Select)

**Interfaces:**
- Consumes: motion tokens + `pop-in` + `pressable`.
- Produces:
  - `Popover` — `<Popover trigger={ReactNode} children side?="top"|"bottom" align?>`: Base UI Popover with flip/shift collision handling, portal, focus return, Escape close, `pop-in` entrance (180ms), 120ms fade exit. The reader composer (PR 1) will consume this.
  - `ConfirmAction` — same public props as today's `confirm-action.tsx` (read the file; keep the exported names and prop types identical so call sites don't change), now with real focus trap, initial focus on the *cancel* control, Escape close, backdrop.
  - `Select<Value extends string>` — `{ value, onValueChange, options: { value: Value; label: string }[], "aria-label": string }`: Base UI Select styled as `inputClass`-look trigger + surface-card listbox, full keyboard model (arrows/Home/End/typeahead), `pop-in` entrance. Replaces native selects app-wide over the screen PRs.

- [ ] **Step 1: Install** — `npm install @base-ui-components/react` (verify it appears in `package.json` dependencies; run `npm run build` once to confirm RSC compatibility).

- [ ] **Step 2: Build `popover.tsx`** styled with tokens: content = `rounded-md border border-rule bg-surface p-4 shadow-[var(--shadow-sheet)] pop-in font-sans`, exit via Base UI's `data-ending-style` mapped to `opacity-0` with `transition-opacity duration-[120ms]`.

- [ ] **Step 3: Rebuild `confirm-action.tsx`** on `AlertDialog.Root/Trigger/Portal/Backdrop/Popup`: backdrop `bg-[color-mix(in_oklab,var(--page)_60%,transparent)] backdrop-blur-[2px]`, popup = `panelClass` + `w-full max-w-sm`, confirm button `primaryButtonClass`, cancel `secondaryButtonClass` with `initialFocus` on cancel. Keep existing exported component name/props exactly.

- [ ] **Step 4: Build `select.tsx`** and swap the sidebar lab switcher (`sidebar.tsx:45-59`) to it. Trigger shows current lab name in `font-sans text-sm`; listbox items get `pressable` + `data-highlighted:bg-surface-sunken`.

- [ ] **Step 5: Verify** — lint/types/unit/e2e green; dev-mode: lab switcher opens with 180ms settle, arrows + typeahead work, Escape returns focus to trigger; confirm dialog traps Tab and starts on cancel.

- [ ] **Step 6: Commit** — `git commit -m "feel: Base UI popover, confirm dialog, styled select"` and push.

---

### Task 8: ⌘K command palette shell

**Files:**
- Create: `lib/command.ts` (pure fuzzy subsequence matcher + ranker)
- Test: `lib/command.test.ts`
- Create: `app/(app)/app/_components/command-palette.tsx`
- Modify: `app/(app)/app/layout.tsx` (mount inside ToastProvider)

**Interfaces:**
- Consumes: Task 7's Base UI Dialog pattern, Task 1 press grammar.
- Produces:
  - `lib/command.ts`: `fuzzyScore(query: string, target: string): number | null` (null = no match; higher = better; subsequence match, bonus for word-start hits and consecutive runs, case-insensitive) and `rankCommands<T extends { label: string; keywords?: string[] }>(query: string, items: T[]): T[]`.
  - `command-palette.tsx`: global ⌘K/Ctrl+K listener; static command list for PR 0: `Go to lab home`, `Go to Library`, `Go to Sessions`, `Sign out` (router.push / signOut — same calls the sidebar makes). Keyboard: arrows move `aria-activedescendant`, Enter runs + closes, Escape closes, focus returns. Opens with **120ms** entrance (keyboard-triggered: fast, minimal motion — opacity only, no translate). A visible `⌘K` hint chip is added to the sidebar footer.

- [ ] **Step 1: Write failing matcher tests:**

```ts
// lib/command.test.ts
import { describe, expect, it } from "vitest";
import { fuzzyScore, rankCommands } from "./command";

describe("fuzzyScore", () => {
  it("matches subsequences", () => {
    expect(fuzzyScore("gtl", "Go to Library")).not.toBeNull();
  });
  it("rejects non-subsequences", () => {
    expect(fuzzyScore("xyz", "Go to Library")).toBeNull();
  });
  it("prefers word-start matches", () => {
    const wordStart = fuzzyScore("lib", "Go to Library")!;
    const scattered = fuzzyScore("oor", "Go to Library")!;
    expect(wordStart).toBeGreaterThan(scattered);
  });
  it("empty query matches everything at score 0", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("rankCommands", () => {
  it("orders by score and drops non-matches", () => {
    const items = [
      { label: "Go to Sessions" },
      { label: "Go to Library" },
      { label: "Sign out" },
    ];
    expect(rankCommands("lib", items).map((i) => i.label)).toEqual([
      "Go to Library",
    ]);
  });
  it("searches keywords too", () => {
    const items = [{ label: "Go to Library", keywords: ["papers"] }];
    expect(rankCommands("papers", items)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, verify fail.** `npm run test -- command`

- [ ] **Step 3: Implement `lib/command.ts`:**

```ts
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return 0;
  let score = 0;
  let ti = 0;
  let prevHit = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    const wordStart = found === 0 || t[found - 1] === " ";
    score += wordStart ? 3 : 1;
    if (found === prevHit + 1) score += 2;
    prevHit = found;
    ti = found + 1;
  }
  return score;
}

export function rankCommands<
  T extends { label: string; keywords?: string[] },
>(query: string, items: T[]): T[] {
  return items
    .map((item) => {
      const scores = [item.label, ...(item.keywords ?? [])]
        .map((s) => fuzzyScore(query, s))
        .filter((s): s is number => s !== null);
      return { item, score: scores.length ? Math.max(...scores) : null };
    })
    .filter((x): x is { item: T; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}
```

- [ ] **Step 4: Run tests, verify pass.**

- [ ] **Step 5: Build the palette component + mount it; add the sidebar `⌘K` hint chip** (render `⌘K` on Mac platforms, `Ctrl K` otherwise, via `navigator.platform` check in an effect to avoid hydration mismatch). Input is `font-sans`; result rows show label + a muted section hint; match `data-highlighted` styling from Task 7's select.

- [ ] **Step 6: Verify** — lint/types/unit/e2e; dev-mode: ⌘K from every screen, type `gtl` → Enter lands on Library, Escape restores focus.

- [ ] **Step 7: Commit** — `git commit -m "feel: command palette shell (cmd+k)"` and push.

---

### Task 9: Autofocus + first-input pass

**Files:**
- Modify: `app/(app)/signin/page.tsx` (autofocus email field)
- Modify: `app/(app)/app/_components/onboarding.tsx` (autofocus lab-name field)
- Modify: `app/(app)/app/library/_components/add-paper.tsx` (autofocus DOI field when the form opens)

**Interfaces:** none new.

- [ ] **Step 1:** In each file, find the first text input of the primary form and add React's `autoFocus` attribute. For `add-paper.tsx` the form appears on demand — `autoFocus` on mount is correct there too. Verify no scroll-jump on mobile layouts (the fields are above the fold in all three).

- [ ] **Step 2: Verify** — lint/types/tests; dev-mode: landing → sign in → cursor is already in the email field; create-lab and add-paper same.

- [ ] **Step 3: Commit** — `git commit -m "feel: autofocus first fields"` and push.

---

### Task 10: Feel regression suite + PR

**Files:**
- Modify: `e2e/feel.spec.ts` (extend)
- Create: PR via `gh`

- [ ] **Step 1: Extend `e2e/feel.spec.ts`** with the app-wide invariants that don't need auth:

```ts
test("landing has no dead buttons", async ({ page }) => {
  await page.goto("/");
  for (const el of await page.getByRole("button").all()) {
    if (await el.isVisible()) {
      await expect(el).toHaveCSS("cursor", "pointer");
    }
  }
});

test("reduced motion is honored", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/signin");
  const button = page.getByRole("button").first();
  const transition = await button.evaluate(
    (el) => getComputedStyle(el).transition,
  );
  expect(transition).not.toContain("scale 0.06s");
});
```

(The reduced-motion expectation relies on `pressable`'s scale transition being inside `motion-safe`. If Step 1 of Task 1 put the whole `transition` declaration outside the media query, the *property* still lists `scale` — in that case assert instead that `:active` produces no scale change: evaluate `getComputedStyle(el).scale` while dispatching pointerdown, expect `"none"`. Pick whichever assertion matches the final Task 1 implementation and delete the other.)

- [ ] **Step 2: Full local gate** — `npm run lint && npx tsc --noEmit && npm run typecheck:convex && npm run test && npm run test:e2e && npm run build`. All green.

- [ ] **Step 3: Open the PR** —

```bash
git push && gh pr create --base main \
  --title "Foundation: the interaction layer (press feel, skeletons, toasts, optimistic writes, cmd+k)" \
  --body "$(cat <<'EOF'
PR 0 of the product-feel overhaul (spec: docs/superpowers/specs/2026-08-08-product-feel-overhaul-design.md).

- 60ms compositor-only press grammar + cursor base layer on every control
- Motion tokens (press 60 / hover 150 / enter 180 / exit 120, ease-settle)
- Shimmer skeletons + route-level loading states (no more blank flashes)
- Router staleTimes + nav prefetch; sticky sidebar
- Toast/undo layer; optimistic-mutation helper with visible rollback
- Base UI popover / confirm dialog / styled select primitives
- Cmd+K command palette shell; autofocus on first fields
- e2e feel regression suite (cursor, press timing, reduced motion)

Per-screen PRs (reader, sessions, library, shell/theme) build on these primitives — see the spec's roadmap.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4:** Monitor CI + Greptile per repo workflow; fix findings; do not merge until both gates are green.

---

## Self-review notes

- Spec coverage: press grammar (T1), skeletons/loading (T2), nav (T3), sidebar (T4), toast+undo (T5), optimistic helper (T6), primitives incl. select replacement (T7), ⌘K (T8), autofocus (T9), CI/validation (T10). Datetime-local replacement deliberately rides PR 2 (sessions owns the only call site); theme toggle rides PR 4 — both stated in the spec roadmap.
- Type consistency: `ToastInput`/`useToast` names match between T5 and T6; `pressable`/`chipButtonClass`/`skeletonClass` names match T1→T2→T7/T8.
- Convex `OptimisticUpdate` typing flagged inline as the one API surface to verify against the installed version.
