# Margin product-feel overhaul — design

**Date:** 2026-08-08 · **Status:** approved by Krish (interactive demo + approach summary) · **Demo:** `.context/design-demo/margin-feel.html` · **Evidence:** `.context/research/{product-audit,code-audit,craft-research,conductor-teardown}.md`

## Problem

The product reads as a static page with AI stapled on. Four audits (live-product walk, static code audit, Notion/Google Docs craft research, conductor.build teardown) converge: the visual token layer is craft-grade, but the interaction layer is missing — dead controls, network-gated clicks, blank loading, unanchored margin rail, off-screen composer, trap states. The README screenshots are all real features; the gaps are fidelity, not vapour.

## Goal

Notion/Google Docs-class feel: every input acknowledged within one frame, every surface enters deliberately, nothing waits on the network to respond, nothing shifts after it has settled. **The user's stated top priority: buttery 120Hz press feel on every click.**

## Interaction language (the contract every PR implements)

### Press feel — P0, non-negotiable
- Every interactive control: `cursor: pointer`; disabled: `cursor: not-allowed` + reduced ink.
- Press feedback starts on **`pointerdown`**, not `click`: `scale(0.98)` + slight ink darken, ~60ms in; release ~120ms out.
- Compositor-only animation: `transform` and `opacity` exclusively — never layout/paint properties, never `transition: all`. This is what makes it render at native refresh (120Hz ProMotion) regardless of main-thread work.
- The click handler path must not block the frame: no synchronous heavy re-renders, no awaited network before visual response. Optimistic updates are part of press feel, not a separate feature.

### Motion budget
- Hover: 150ms, color/alpha only. Nothing translates or grows shadow on hover.
- Enter: 180ms `cubic-bezier(0.16, 1, 0.3, 1)` (existing `margin-pop`), opacity + 4px translate + scale from 0.985. Exit: 120ms.
- Keyboard-triggered actions render instantly — no entrance animation.
- `prefers-reduced-motion`: durations collapse, press scale drops.

### Data + loading
- Every Convex mutation on a user-visible surface uses `.withOptimisticUpdate` (new objects only — never mutate `localStore` values in place). Rollback is visible: toast + state restore (e.g. failed note save reopens composer with draft intact).
- Loading = shimmer skeletons shaped like the incoming content, single-paint resolution, zero post-settle layout shift. No spinners, no blank flashes, no false empty states (empty copy renders only after data has loaded empty).
- Navigation: route-level `loading.tsx` skeletons; `staleTimes` config + hover `router.prefetch()` so nav clicks don't refetch (Next 15 defaults dynamic routes to `staleTime: 0`).

### Structure
- Shared primitives, used everywhere; no ad-hoc popovers/dialogs/menus. New deps: **Floating UI** (collision-aware positioning: flip/shift/size) and headless primitives (Base UI) for dialog/menu focus-trap + ARIA keyboard models. Styled entirely with existing tokens.
- Toast + undo layer (there is currently none). Destructive/irreversible actions get confirm or undo.
- ⌘K command palette shell (navigate, filter, add paper), extended per screen.
- Theme: manual toggle **auto / light / dark, default dark** (matches README "dark mode throughout"), replacing the wall-clock switch. Infrastructure already supports it (`.light`/`.dark` classes).

## PR roadmap (interleaved: each screen PR = polish + its README-fidelity features)

- **PR 0 — Foundation:** control classes (cursor/hover/press), motion tokens, toast+undo, confirm dialog, Floating-UI popover primitive, optimistic-mutation helper, route skeletons + prefetch/staleTimes, ⌘K shell, sticky sidebar (`sticky top-0`, surface color to full height), styled select/datetime/details replacements, autofocus on first fields.
- **PR 1 — Reader (flagship):** anchored margin rail — per-note vertical alignment to its passage, colliding runs condense via minimal-displacement relax, bidirectional hover linking (wash intensify + type-colored hairline connector); composer flip/shift so it is always fully visible, selection stays lit while composing, ⌘↵ saves; reserved height for filter-chip bar; higher highlight alpha; zoom (fit-width/±) + page jump; Tab no longer walks 37 unlabeled page containers.
- **PR 2 — Sessions:** Start session disabled outside window with inline hint (no console server errors, fix "isn't until in about 25 hours"); End/Cancel get confirm + undo toast; board quotes trimmed to sentence boundaries, `[nn]` debris stripped; legible type-distribution bar; synthesis citations numbered `Note 1..n` stable per note; session↔reader loop ("← Back to session" in reader header).
- **PR 3 — Library/ingest:** collapse post-ingest triple-title; `Done adding`/`Record` look like controls; upload byte progress + cancel.
- **PR 4 — Shell & theme:** theme toggle, digest placement (no mid-page pop-in), README screenshot regeneration to match shipped reality.

## Validation & CI

Per existing repo rules: feature branch → small commits → PR → Greptile + Opus review → merge green. Each PR gets a Vercel preview deploy and a browser feel-test pass (Playwright: verify cursor styles, press-state computed transitions, no layout shift on settle, composer visibility at bottom-of-viewport selections). Existing suites (lint, types, 149 unit tests, Playwright smoke, privacy guard) must stay green; anchoring changes extend the 78 anchoring unit tests where behavior is added, not changed.

## Non-goals

Backend/memory-layer architecture, pricing content (banned), mobile-first redesign (mobile usability fixes ride along but are not the bar), new features beyond README fidelity.

## Out-of-scope items flagged by audits (tracked, not in these PRs)

Digest surface not observable in 1-member labs (needs multi-member test data); full projector mode for live sessions; text-reflow reading mode.
