# Wave 5 / V1 — three.js scan & wireframe spike

Status: **DONE_WITH_CONCERNS**. Draft PR opened; nothing merged.

## What shipped, and where

Two surfaces, as scoped, plus one shared core.

- `lib/scan/sweep.ts` — the sweep's clock, as a pure function of elapsed time.
  Returns whether a frame is warranted, the phase, and how long the caller may
  sleep. Unit-tested (`lib/scan/sweep.test.ts`, 7 cases).
- `lib/scan/palette.ts` — reads `--accent` / `--ink-faint` off the live
  element and re-reads on `<html>` class mutation and on
  `prefers-color-scheme` change. This is how both halves of the theme grammar
  are honoured without the scene holding a third opinion about what dark is.
- `app/(marketing)/_components/scan-field.tsx` — the WebGL field.
- `app/(marketing)/_components/scan-field-mount.tsx` — the `next/dynamic`,
  `ssr: false` boundary. The only door three.js comes through.
- `lib/scan/scan-sweep.{tsx,module.css}` — the shelf row treatment, CSS only.
- `app/(marketing)/page.tsx`, `app/(app)/app/library/page.tsx` — mount points.

Copy untouched. No Convex, reader, sessions, digest, auth or middleware
changes. No pricing content.

## Design decisions worth a founder's attention

**The wireframe is drawn in the fragment shader, not by wireframe geometry.**
`wireframe: true` renders triangle edges — every quad crossed by a diagonal —
which reads as a modelling-tool mesh, and WebGL will not honour line width
anyway. A grid derived from the surface's own coordinates and antialiased with
`fwidth` is one draw call, crisp at any DPR, and lets the distance fade be
analytic instead of a fog hack.

**The pulse is two decays, not one.** A single exponential spreads the light
over the whole field and reads as a gradient drifting past. What makes it a
survey is a tight rim (~1 unit) that glows off the ground *between* the
rulings, plus a dimmer wash several units behind it that only brightens the
lines. The first pass had one decay and looked like a wipe; that is the single
biggest visual change between commit 1 and commit 2.

**The renderer is on demand.** The scene animates for 2.8s of every 9s. Frames
are requested by hand — `requestAnimationFrame` while the front moves, a
`setTimeout` across the gap — so two thirds of the cycle costs nothing.

**The rows are CSS, not WebGL.** Browsers cap live WebGL contexts near
sixteen; a canvas per row is not merely heavy, it is broken — the seventeenth
paper would take the first one's renderer. The band is a gradient behind a
moving mask, with the ruling counter-translated *inside* the band so the grid
stays put while the light crosses it (band is 40% of the row, ruling is 250%
of the band, so the ruling is exactly one row wide and the percentages
cancel). Two transforms and an opacity — nothing the compositor doesn't own.

## Measurements

### Route bundle (`npx next build`, this branch vs `012a0c9`)

| Route | Base size | Now | Δ | Base First Load | Now | Δ |
|---|---|---|---|---|---|---|
| `/` | 11.3 kB | 12.4 kB | **+1.1 kB** | 159 kB | 160 kB | **+1 kB** |
| `/app/library` | 16.5 kB | 16.8 kB | **+0.3 kB** | 186 kB | 186 kB | **0** |
| all other routes | — | — | **0** | — | — | **±1 kB noise** |

The table understates the real cost, because three.js is in an async chunk
Next does not count in First Load JS. Measured over the wire against
`next start`, the landing page goes from **8 JS files / 157 kB** to **13 JS
files / 395 kB** — **+238 kB**, all fetched after the page is interactive.
Two new chunks carry it (~98 kB and ~85 kB gzipped). Routes that do not show
the effect fetch none of it.

### Main thread

- **Duty cycle confirmed.** rAF callbacks sampled in 500 ms buckets over 12 s:
  `0 0 0 0 0 0 0 0 0 0 0 128 180 180 180 180 162 0 0 0 0 0 0 0`. Six of every
  nine seconds schedule zero animation frames. Baseline landing page: 0.
- **One long task, at init.** 69 ms at t≈387 ms, ~77 ms after the canvas
  appears — chunk parse plus shader compile. A second run saw 52 ms and
  174 ms, so call it 50–175 ms one-off, machine-dependent.
- **Zero long tasks during sweeps**, across 15 s covering two full cycles.
- DPR capped at 2, MSAA off (the grid is analytically antialiased),
  `powerPreference: "low-power"`, ~5.8k vertices, one draw call.

### Verified in a real browser

Dark, light, and `auto` + light system (the media-query branch, which a
hardcoded palette would have broken); 1× and 2× DPR; reduced motion on and
off. Screenshots for each are in `docs/spike/`, captured against a production
build.

## Concerns and flagged items

1. **+238 kB over the wire for a decoration** is the real trade, and it is a
   judgment call, not a bug. It is deferred, code-split, and off every other
   route — but it is still a third of a megabyte for a masthead. If the answer
   is no, the shelf treatment stands on its own at ~0.3 kB.
2. **Pre-existing hydration error on the landing page under reduced motion.**
   "Hydration failed because the server rendered HTML didn't match the
   client." **Not caused by this branch** — I isolated it by removing
   `<ScanFieldMount />` and it still reproduces on the untouched page. It comes
   from the `motion` entrance components (`Rise` / `Reveal`), which also log
   motion.dev's reduced-motion warning. Worth its own issue.
3. **`THREE.Clock` deprecation warning** logged by R3F 9.7 internals on three
   0.185. Cosmetic, upstream, nothing to do here.
4. **Reduced motion is read once, not watched.** Changing the OS setting
   mid-session takes effect on the next navigation. Deliberate: a listener
   that could start a WebGL scene moving under someone who just asked for less
   motion is the worse failure.
5. **The scan layer paints above the masthead's flat ruling**, not below it —
   `HeroSurface` renders its decoration layers before `children`. At these
   opacities it is imperceptible, and putting it underneath would mean editing
   `hero-surface.tsx`, which was outside the allowlist. Easy to change if the
   order matters.
6. **`docs/spike/` is ~7.6 MB** of PNG and one webm. Fine for a draft built
   for judgment; should not merge as-is.
7. **Shelf screenshots came from the dev server**, hero screenshots from a
   production build. The shelf needs a signed-in lab with papers, which I
   seeded on the dev deployment by importing five real DOIs through the
   product's own reference-import path. No Convex code was touched and
   `convex deploy` was never run.

## V2 candidates, if this is approved

- **Scout finding cards** — the strongest next fit. A finding surfacing from
  across sessions *is* something being detected; the scan grammar would be
  carrying meaning there rather than decorating.
- **Session board** — a sweep as a session opens, staggered across the
  columns, reusing `ScanSweep` unchanged.
- **Digest / brief arrival** — one pass when a brief lands, as arrival
  notation.
- Not the reader. The reading surface is where the product asks for
  attention on the text; a light crossing a paragraph would be competing with
  the thing it is for.

The shelf treatment generalises for free — `ScanSweep` + `scanRowClass` is the
whole integration, two lines at any call site. The field does not: it is
specific to a masthead with room for terrain.

## Gates

`npx vitest run` 1564 passed / 81 files · `npx tsc --noEmit` clean ·
`npx eslint .` clean · `npx next build` succeeds.
