# A3 — Library / ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shelf row addresses each destination once and names what a paper still needs instead of chipping it; the lane's quiet controls acknowledge a press; and an upload says how many bytes have gone, can be called off, and never throws away a title the member typed by hand.

**Architecture:** Three pure `.ts` cores land beside their components (`shelf-row.ts`, `upload-flow.ts`) or in `lib/` and carry the vitest coverage — the harness is node-only, so nothing renders and the decisions are tested as functions. The class-level guarantee is locked by a source-text test copied from `read/_components/press-grammar.test.ts`. The transport moves from `fetch` to `XMLHttpRequest` because `fetch` cannot report a request body's progress in any browser, and `lib/pdf/extract.ts` gains one **additive** optional `signal` so the long wait — reading the pages, not sending them — can also be withdrawn. Ground truth for every line number and every current behaviour: `.superpowers/sdd/a3-library/audit.md`, accurate as of branch cut `6b86273`; each task restates what it needs from it.

**Tech Stack:** Next.js App Router, Convex, pdf.js (`pdfjs-dist`), Tailwind semantic tokens, vitest (node env — no DOM harness, no jsdom, `.ts` tests only; browser-only behaviour is verified in a manual pass at the end).

## Global Constraints

- All UI classes come from `lib/ui.ts`; colour via semantic tokens only (`app/globals.css:236–261`); chrome is sans, anything read or written is serif.
- Press grammar is `@utility pressable` (`app/globals.css:318–332`): compositor-only, `scale: 0.98` on `:active:not(:disabled)`, colour over `--dur-hover`, scale over `--dur-press`. Never `transition: all`, never a layout property, never a `cursor` in a utility (the base layer owns the cursor; `e2e/feel.spec.ts:49–70` fails if anyone puts one back).
- `tap-target` (`globals.css:350–366`) grows a hit box to 44px via a `::after`. Keep ~44px between the centres of adjacent ones.
- `useQuery` comes from `convex-helpers/react/cache/hooks`, never `convex/react` (eslint-enforced over `app/**` and `lib/**`). `useMutation`/`useAction` still come from `convex/react`.
- Human-readable refusals arrive as `ConvexError` and render through `readableError` into `<p role="alert" className={errorClass}>`. pdf.js failures go through `describePdfOpenError` **first**, then fall back to `readableError`.
- Comments carry the reasoning and never restate the code; a doc block sits over the declaration it explains. A comment that has stopped being true is a bug in this repo's terms — if a task changes behaviour a comment describes, that task rewrites the comment in the same commit.
- The `Content-Type: application/pdf` header on the upload is load-bearing, not cosmetic: the stored content type is what `requireStoredPdf` checks before `createFromUpload` will let a paper point at the blob (`pdf-ingest.ts:14–20`). It survives the transport change.
- No pricing or monetization content anywhere in copy.
- Baseline at branch cut: `npm test` → **62 files, 1181 tests, all passing**. That must stay green; this plan adds three files.
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## Two decisions settled here, so no task re-litigates them

**1. What "post-ingest triple-title" means.** The rule this lane adopts is **one navigational affordance per destination per surface**. The audit is right that the literal title string never renders three times on one screen (`audit.md` §a.2) — so no task may assert it does. What does happen is that a freshly ingested paper is not `ready` on first paint, and in that state the shelf row's title (`page.tsx:349–358`) and the row's action (`page.tsx:394–403`) resolve to *the same URL*, one as a full-width serif title and one as a sentence with an arrow, with a `StatusChip` (`page.tsx:359`) saying a third time that something is unfinished. That is the duplication being collapsed, and the collapse is:

> A shelf row carries exactly one link per destination. A **readable** paper has two destinations and so two links — the title opens the reader, and a quiet second link opens the record. A paper that is **not** readable has one destination, the record, and so one link: the named action that says what going there will accomplish. The title is not a link in that state, because it would be the second route to the one place. The `StatusChip` leaves the shelf row, because the named action now says which preparation is missing, in words, in the accent — which is exactly what the comment at `page.tsx:390–393` already claims and has never been true.

**2. Where the vocabulary gets fixed, and the sanctioned fence expansion.** `linkButtonClass` (`lib/ui.ts:53–54`) is the app's whole quiet-control vocabulary and it is the one control class with no `pressable` in it — `primaryButtonClass`, `secondaryButtonClass` and `chipButtonClass` all have it (`lib/ui.ts:43–51, 85`). `ConfirmAction` proves the omission is a mistake rather than a decision: it composes `` `font-sans ${scale} ${quiet} pressable tap-target` `` inline (`confirm-action.tsx:104`), which is `linkButtonClass` + `pressable` + `tap-target` written out by hand because the export did not offer it.

Task 2 therefore adds `pressable` to `linkButtonClass` itself. **This is a declared, deliberate expansion of the A3 conflict-map fence** (`TIMELINE.md §5` puts only "Library/ingest UI" in this lane). It reaches 12 call sites outside the lane — `agenda-templates.tsx:211, 226, 330`; `toast.tsx:197`; `signin/page.tsx:317, 441, 449, 463, 475`; `sidebar.tsx:132` — every one of which is a `<button>` (verified), so `:active:not(:disabled)` and `user-select: none` are safe on all of them. **It is the one-class change and nothing else**: no task may add `tap-target`, retune a size, or otherwise touch a call site outside `app/(app)/app/library/**`. It also closes the parked backlog item "the toast's Undo lacks press feel" for free, since `toast.tsx:197` is one of the twelve. The PR body must say all of this.

---

### Task 1: A shelf row addresses each destination once

**Files:**
- Create: `app/(app)/app/library/_components/shelf-row.ts`
- Test: `app/(app)/app/library/_components/shelf-row.test.ts`
- Modify: `app/(app)/app/library/page.tsx` (title link ~:349–358, `StatusChip` ~:359, comment + action link ~:389–403)
- Modify: `app/(app)/app/library/_components/add-paper.tsx` (`DoiOutcome` link ~:288–297)

Note: `paper-meta.tsx` is **not** modified. `StatusChip` keeps its other caller on the record page (`[paperId]/page.tsx:67`), where a single chip beside a single h1 is not a duplicate of anything. Only the shelf row loses it.

**Interfaces:**
- Produces: `shelfRow(paper: { ingestStatus: IngestStatus; hasPdf: boolean }): ShelfRow`, where

```ts
export type ShelfRow = {
  /** True when the title itself is the row's link into the reader. */
  titleOpensReader: boolean;
  /** The row's one link to the record. `named` when it is the row's only link. */
  record: { label: string; tone: "quiet" | "named" };
};
```

- `IngestStatus` already exists and is imported from `./paper-meta` (`paper-meta.tsx:9`); its five values are `"needs-pdf" | "pending" | "extracting" | "ready" | "failed"` (`convex/schema.ts:173–179`).
- Consumed by `page.tsx` only. Task 2 changes the *classes* on the same two elements and relies on the labels being decided here — do not move labels into Task 2.

- [ ] **Step 1: Write the failing test**

```ts
// app/(app)/app/library/_components/shelf-row.test.ts
import { describe, expect, it } from "vitest";
import { shelfRow } from "./shelf-row";

describe("shelfRow", () => {
  it("gives a readable paper two destinations and two links", () => {
    const row = shelfRow({ ingestStatus: "ready", hasPdf: true });
    expect(row.titleOpensReader).toBe(true);
    expect(row.record).toEqual({ label: "Open its record", tone: "quiet" });
  });

  it("never leaves two links pointing at the record", () => {
    // The regression this file exists to prevent: before #A3 the title and
    // the action below it both resolved to /app/library/{id} for every paper
    // that was not yet readable, which is every paper for its first seconds.
    for (const paper of [
      { ingestStatus: "pending", hasPdf: true },
      { ingestStatus: "extracting", hasPdf: true },
      { ingestStatus: "failed", hasPdf: true },
      { ingestStatus: "needs-pdf", hasPdf: false },
      { ingestStatus: "ready", hasPdf: false },
    ] as const) {
      const row = shelfRow(paper);
      expect(row.titleOpensReader).toBe(false);
      expect(row.record.tone).toBe("named");
    }
  });

  it("names the missing preparation rather than chipping it", () => {
    expect(shelfRow({ ingestStatus: "needs-pdf", hasPdf: false }).record.label).toBe(
      "This paper still needs its PDF →",
    );
    expect(shelfRow({ ingestStatus: "failed", hasPdf: true }).record.label).toBe(
      "Its text wouldn’t come out — see why →",
    );
    expect(shelfRow({ ingestStatus: "extracting", hasPdf: true }).record.label).toBe(
      "Finish preparing this paper →",
    );
  });

  it("treats a missing file as the gap to name, whatever the status says", () => {
    // `ready` with no PDF is reachable (the record can be created before the
    // file arrives) and "finish preparing" would not say which half is missing.
    expect(shelfRow({ ingestStatus: "ready", hasPdf: false }).record.label).toBe(
      "This paper still needs its PDF →",
    );
    expect(shelfRow({ ingestStatus: "failed", hasPdf: false }).record.label).toBe(
      "This paper still needs its PDF →",
    );
  });
});
```

- [ ] **Step 2: Run it** — `npx vitest run "app/(app)/app/library/_components/shelf-row.test.ts"` — FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// app/(app)/app/library/_components/shelf-row.ts
import type { IngestStatus } from "./paper-meta";

export type ShelfRow = {
  /** True when the title itself is the row's link into the reader. */
  titleOpensReader: boolean;
  /** The row's one link to the record. `named` when it is the row's only link. */
  record: { label: string; tone: "quiet" | "named" };
};

/**
 * How a shelf row addresses the paper it names.
 *
 * A row carries one link per destination, and a paper that cannot be read has
 * only one destination worth offering: its record, where the missing half gets
 * fixed. The title used to link there too — the same URL, twice, in one row,
 * for every paper in the seconds after it arrives — with a status chip beside
 * it saying a third time that something was unfinished. So the title is a link
 * only when it goes somewhere the second link doesn't, and the second link
 * says what the trip is for instead of leaving a chip to be decoded.
 *
 * A pure function rather than a ternary in the row, because "never two links
 * to one URL" is an invariant and an invariant in JSX cannot be tested — this
 * harness has no DOM.
 */
export function shelfRow(paper: {
  ingestStatus: IngestStatus;
  hasPdf: boolean;
}): ShelfRow {
  if (paper.ingestStatus === "ready" && paper.hasPdf) {
    // The one state the margins can be written in, so the title goes straight
    // to the reader and the record steps back to a quiet second door.
    return {
      titleOpensReader: true,
      record: { label: "Open its record", tone: "quiet" },
    };
  }

  // The file first, whatever the status says about the text: text can't be
  // read out of a paper there is no copy of, so naming the status here would
  // name the wrong gap.
  const label = !paper.hasPdf
    ? "This paper still needs its PDF →"
    : paper.ingestStatus === "failed"
      ? "Its text wouldn’t come out — see why →"
      : "Finish preparing this paper →";

  return { titleOpensReader: false, record: { label, tone: "named" } };
}
```

- [ ] **Step 4: Run it** — `npx vitest run "app/(app)/app/library/_components/shelf-row.test.ts"` — PASS.

- [ ] **Step 5: Redraw the row.** In `page.tsx`, import `shelfRow` from `./shelf-row` and drop the `StatusChip` import from `./paper-meta` (keep `byline`). Inside `shown.map`, replace the `readable` const (~:333) and the two elements below it.

Replace the comment and const at ~:328–333 with:

```tsx
const line = byline(paper);
// A readable paper is one whose text layer is in, which is the only state
// the margins can be written in — so its title opens the reader and its
// record steps back to a second, quieter link. Anything else has one place
// worth going and one thing worth doing there, and `shelfRow` is where that
// stays true: the row must never offer the same URL twice.
const row = shelfRow(paper);
```

Replace the title span (~:348–360) with:

```tsx
<span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
  {row.titleOpensReader ? (
    <Link
      href={`/app/library/${paper._id}/read`}
      className="font-serif text-xl leading-snug text-ink-strong underline-offset-4 hover:underline"
    >
      {paper.title}
    </Link>
  ) : (
    // Not a link, and drawn as one thing rather than two: the underline
    // was promising a second route to the record, which the named action
    // below already is. The row is still focusable and `↵` still opens it.
    <span className="font-serif text-xl leading-snug text-ink-strong">
      {paper.title}
    </span>
  )}
</span>
```

Replace the action link and its comment (~:389–403) with:

```tsx
<span className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
  {/* A paper that can't be read yet has exactly one thing worth doing to
      it, and a chip reading "TEXT PENDING" next to a title says neither
      what that is nor where. One named action, in the accent, carrying
      both — which is why the chip that used to sit beside the title is
      gone rather than sitting above this saying the same thing quieter. */}
  <Link
    href={`/app/library/${paper._id}`}
    className={
      row.record.tone === "quiet"
        ? "tap-target font-sans text-xs text-ink-faint underline-offset-4 hover:text-accent hover:underline"
        : "tap-target font-sans text-sm text-accent underline-offset-4 hover:underline"
    }
  >
    {row.record.label}
  </Link>
```

(the `Filed as…` button and the `FiledAs` panel below it are untouched).

- [ ] **Step 6: Stop the add panel repeating the shelf.** `DoiOutcome` (`add-paper.tsx:248–300`) renders `Read {title}` / `Open {title}` / `Attach the PDF to {title}` while the shelf below it renders the same title again — the panel is pinned open by `onAdded` precisely so the outcome can be read, so it is the surface that keeps the affordance, and the *title* is what stops being said twice. Replace the `<Link>` at ~:288–297 with:

```tsx
      <Link
        href={ready ? `${record}/read` : record}
        className="tap-target self-start font-sans text-sm text-accent underline-offset-4 hover:underline"
      >
        {ready
          ? "Read it now"
          : result.hasPdf
            ? "Open its record"
            : "Attach the PDF"}
      </Link>
```

and extend the component's doc block (~:233–247) with the reason, appended as a new paragraph before the closing `*/`:

```
 * The paper is named once on this screen and it is named on the shelf below,
 * so this link names the act instead: the sentence above has just said which
 * paper this is about, and repeating its title here only made two entries for
 * one paper in the same field of view.
```

- [ ] **Step 7: Whole suite, typecheck, lint** — `npx vitest run && npx tsc --noEmit && npm run lint` — PASS. Confirm `StatusChip` is still imported and used by `app/(app)/app/library/[paperId]/page.tsx` (`grep -n StatusChip "app/(app)/app/library/[paperId]/page.tsx"`) so the export has not been orphaned.

Manual-pass items for the end-of-plan browser pass: a freshly added paper's row shows one accent action and no chip; its title is plain ink with no underline on hover; `↓`/`↵` still opens the marked row; a `ready` row still shows the title as a link to `/read` plus `Open its record`.

- [ ] **Step 8: Commit.**

```bash
git add "app/(app)/app/library/_components/shelf-row.ts" \
        "app/(app)/app/library/_components/shelf-row.test.ts" \
        "app/(app)/app/library/page.tsx" \
        "app/(app)/app/library/_components/add-paper.tsx"
git commit -m "Shelf: one link per destination, and the action names the gap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: The lane's quiet controls become controls

**Files:**
- Modify: `lib/ui.ts` (`linkButtonClass`, :53–54) — **the declared fence expansion, see the decision at the top**
- Modify: `app/(app)/app/library/page.tsx` (`Download BibTeX` ~:243–256, `Done adding` ~:268–276, the record link ~:394–403, `Filed as…` ~:404–415, the `Escape` case ~:180–184)
- Modify: `app/(app)/app/library/_components/add-paper.tsx` (`TabButton` ~:100–117)
- Modify: `app/(app)/app/library/_components/pdf-dropzone.tsx` (the drop button ~:44–70)
- Modify: `app/(app)/app/library/_components/pdf-panel.tsx` (`Open the PDF` ~:257–264, `Read its text layer` ~:265–276)
- Test: `app/(app)/app/library/_components/press-grammar.test.ts` (new)

**Interfaces:**
- Consumes: `shelfRow` from Task 1 — the record link's *labels* were decided there; this task only changes its class strings.
- Produces: `linkButtonClass` now contains `pressable`. Nothing else's signature changes.

- [ ] **Step 1: Write the failing test**

```ts
// app/(app)/app/library/_components/press-grammar.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The library was the last surface where a quiet control was inert under the
 * finger. Every button in it was drawn from the same inline string as the
 * prose links beside it — `text-accent underline-offset-4 hover:underline` —
 * so nothing in the row distinguished "this goes somewhere" from "this changes
 * the page you are on", and neither of them acknowledged a press.
 *
 * A source check rather than a render check, for the reason the reader's copy
 * of this file gives: there is nothing to render in a node test and nothing to
 * assert about it if there were.
 */

const LANE = join(process.cwd(), "app/(app)/app/library");

const PRESSABLE = [
  "page.tsx",
  "_components/add-paper.tsx",
  "_components/pdf-dropzone.tsx",
  "_components/pdf-panel.tsx",
];

function source(file: string): string {
  return readFileSync(join(LANE, file), "utf8");
}

describe("the library lane's controls", () => {
  it.each(PRESSABLE)("%s uses the shared press grammar", (file) => {
    expect(source(file)).toContain("pressable");
  });

  it.each(PRESSABLE)("%s states no duration the motion budget doesn't name", (file) => {
    expect(source(file)).not.toMatch(/duration-200\b/);
  });

  it.each(PRESSABLE)("%s has no hand-rolled press left in it", (file) => {
    expect(source(file)).not.toContain("scale-[0.96]");
  });
});

describe("the quiet control vocabulary", () => {
  it("carries the press grammar in lib/ui, not at each call site", () => {
    // `ConfirmAction` had to write `linkButtonClass + pressable + tap-target`
    // out by hand because the export didn't offer it. The export offers it now.
    const ui = readFileSync(join(process.cwd(), "lib/ui.ts"), "utf8");
    const declaration = /export const linkButtonClass =([\s\S]*?);/.exec(ui);
    expect(declaration).not.toBeNull();
    expect(declaration?.[1]).toContain("pressable");
  });
});
```

- [ ] **Step 2: Run it** — `npx vitest run "app/(app)/app/library/_components/press-grammar.test.ts"` — FAIL (no `pressable` in `lib/ui.ts`'s `linkButtonClass`, none in the four lane files).

- [ ] **Step 3: Fix the vocabulary centrally.** In `lib/ui.ts`, replace :53–54 with:

```ts
/**
 * A control drawn as a word: an `Undo` in a toast, a `Clear` on the filter
 * strip, a `Sign out`. Quiet on purpose — Margin's chrome is marginalia and
 * padding these up to buttons would turn the margin into a toolbar — but a
 * control all the same, which is what `pressable` says and what this class
 * spent eleven call sites not saying. `ConfirmAction` had already written the
 * combination out by hand rather than importing half of it.
 *
 * Still not `tap-target`: the hit box depends on what sits next to a given
 * one (adjacent 44px boxes overlap), so it stays a call-site decision.
 */
export const linkButtonClass =
  `font-sans text-sm text-accent underline-offset-4 hover:underline ${pressable}`;
```

- [ ] **Step 4: Run the whole suite** — `npx vitest run` — the new file's `lib/ui` case passes, the four `%s uses the shared press grammar` cases still fail. Everything else stays green (**1181 baseline tests, none of them assert the absence of `pressable`** — if any goes red, stop and report rather than weakening it).

- [ ] **Step 5: `Done adding` becomes as findable as the button that opened the panel.** It is the only exit from the add panel and it was drawn quieter than `Add a paper` (`secondaryButtonClass`, `page.tsx:279–286`) which opens it. In `page.tsx`, replace the button at ~:268–276 with:

```tsx
          {!isEmpty && (
            <button
              type="button"
              onClick={() => setAdding(false)}
              // The way out of a panel should not be quieter than the way in:
              // this is the same control as `Add a paper` above, run backwards.
              className={`${secondaryButtonClass} tap-target self-start`}
            >
              Done adding
            </button>
          )}
```

- [ ] **Step 6: `esc` stops lying.** The legend advertises `esc` as "put it all away" (`shortcuts.tsx:27`) and the handler clears only `hint`, `filing` and `marked`. In `page.tsx`, extend the `Escape` case (~:180–184):

```tsx
        case "Escape":
          setHint(false);
          setFiling(null);
          setMarked(null);
          // `a` opens the panel and nothing closed it but a link at the bottom
          // of it. On an empty shelf this is a no-op by design — the panel is
          // rendered by `isEmpty` there, and there is nothing to put away.
          setAdding(false);
          return;
```

- [ ] **Step 7: Press the rest of the lane's controls.** Four class-string edits, each adding `pressable` to what is already there:

`page.tsx` `Download BibTeX` (~:252) — this writes a file to the member's disk, which is not navigation:
```tsx
            className="pressable tap-target self-start font-sans text-xs text-ink-faint underline-offset-4 hover:text-accent hover:underline"
```

`page.tsx` the record link from Task 1 (~:394–403) — a `<Link>`, but one a thumb lands on:
```tsx
    className={
      row.record.tone === "quiet"
        ? "pressable tap-target font-sans text-xs text-ink-faint underline-offset-4 hover:text-accent hover:underline"
        : "pressable tap-target font-sans text-sm text-accent underline-offset-4 hover:underline"
    }
```

`page.tsx` `Filed as…` (~:412) — a toggle that opens a panel in the row:
```tsx
                      className="pressable tap-target font-sans text-xs text-ink-faint underline-offset-4 hover:text-accent hover:underline"
```

`add-paper.tsx` `TabButton` (~:108–113) — the tab strip changes what the panel is:
```tsx
      className={
        "-mb-px border-b-2 pb-2 font-sans text-sm pressable " +
        (active
          ? "border-accent text-ink-strong"
          : "border-transparent text-ink-faint hover:text-ink-muted")
      }
```
(the `transition-colors` goes: `pressable` already eases colour, border-colour and opacity over `--dur-hover`, and leaving both would state the same transition twice with two different durations.)

`pdf-dropzone.tsx` the drop button (~:58–64) — the largest control in the flow:
```tsx
        className={
          "flex w-full flex-col items-center gap-1 rounded-md border border-dashed px-6 py-10 " +
          "pressable disabled:cursor-not-allowed disabled:opacity-50 " +
          (over
            ? "border-accent bg-highlight"
            : "border-rule bg-surface hover:border-ink-faint")
        }
```
(same reason for dropping `transition-colors`.)

`pdf-panel.tsx` `Open the PDF` (~:261) and `Read its text layer` (~:270) — both are `<button>`s wearing the inline idiom; both become the export plus what they already had:
```tsx
              className={`${linkButtonClass} tap-target disabled:opacity-50`}
```
and add `linkButtonClass` to the existing `@/lib/ui` import at `pdf-panel.tsx:8–14`.

- [ ] **Step 8: Whole suite, typecheck, lint** — `npx vitest run && npx tsc --noEmit && npm run lint` — PASS, and `npx playwright test e2e/feel.spec.ts` still passes (it asserts the cursor policy the `pressable` utility deliberately stays out of; nothing here adds a `cursor`).

Manual-pass items: `Done adding` reads as the twin of `Add a paper`; `esc` closes the add panel on a non-empty shelf and does nothing visible on an empty one; the toast's `Undo` now gives under the finger; the dropzone gives under the finger; nothing in signin/sidebar/sessions has moved except that its quiet controls now press.

- [ ] **Step 9: Commit.**

```bash
git add lib/ui.ts \
        "app/(app)/app/library/page.tsx" \
        "app/(app)/app/library/_components/add-paper.tsx" \
        "app/(app)/app/library/_components/pdf-dropzone.tsx" \
        "app/(app)/app/library/_components/pdf-panel.tsx" \
        "app/(app)/app/library/_components/press-grammar.test.ts"
git commit -m "Controls: the quiet vocabulary acknowledges a press

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: The upload says how far it has got, and can be called off

**Files:**
- Create: `app/(app)/app/library/_components/upload-flow.ts`
- Test: `app/(app)/app/library/_components/upload-flow.test.ts`
- Modify: `app/(app)/app/library/_components/pdf-ingest.ts` (`uploadPdf`, :9–28)
- Modify: `lib/pdf/extract.ts` (`ExtractOptions` :38–41, the page loop :168–174) — **additive only**
- Modify: `app/(app)/app/library/_components/add-paper.tsx` (`UploadPhase` ~:304–308, `UploadTab` ~:310–421, `ConfirmUpload` ~:423–505)
- Modify: `app/(app)/app/library/_components/pdf-panel.tsx` (`attach` ~:138–172, the busy line ~:360–364)

`lib/pdf/extract.ts` has three callers — `add-paper.tsx:323`, `pdf-panel.tsx:145`, `use-text-layer.ts:135`. The `signal` field is **optional and additive**, so the third caller compiles unchanged and is not edited by this task.

**Interfaces:**
- Produces, from `upload-flow.ts`:
  - `formatBytes(n: number): string`
  - `bytesProgress(loaded: number, total: number): string`
  - `percentSent(loaded: number, total: number): number | null`
  - `isCancellation(caught: unknown): boolean`
  - `type UploadStage = { kind: "empty" } | { kind: "reading"; pagesDone: number; pageCount: number } | { kind: "read" } | { kind: "sending"; loaded: number; total: number } | { kind: "filing" }`
  - `cancelOffer(stage: UploadStage): { kind: "abort" | "abandon"; label: string } | null`
  - `stageProgress(stage: UploadStage): string | null`
  - `stageAnnouncement(stage: UploadStage): string`
- Produces, from `pdf-ingest.ts`: `uploadPdf(uploadUrl: string, file: File, options?: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal }): Promise<Id<"_storage">>` — the third parameter is optional, both call sites pass it.
- Produces, from `lib/pdf/extract.ts`: `ExtractOptions.signal?: AbortSignal`.
- `add-paper.tsx`'s own `UploadPhase` is `UploadStage` widened with the file it is about; TypeScript's structural assignability lets a `UploadPhase` value be passed straight to every `UploadStage` function above.

**Why XHR, settled here:** `fetch` exposes no upload progress in any browser — there is no event, no callback, and no readable counterpart to `Response.body` for the request side. Request-body streaming over a `ReadableStream` is Chromium-only, HTTP/2-only, and would still mean counting chunks by hand. `XMLHttpRequest`'s `xhr.upload.onprogress` is the only cross-browser transport that reports bytes, and it brings `xhr.abort()` with it, so it answers both halves of this task at once.

- [ ] **Step 1: Write the failing test**

```ts
// app/(app)/app/library/_components/upload-flow.test.ts
import { describe, expect, it } from "vitest";
import {
  bytesProgress,
  cancelOffer,
  formatBytes,
  isCancellation,
  percentSent,
  stageAnnouncement,
  stageProgress,
} from "./upload-flow";

const MB = 1024 * 1024;

describe("formatBytes", () => {
  it("counts bytes under a kilobyte", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });
  it("counts whole kilobytes under a megabyte", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(862_208)).toBe("842 KB");
  });
  it("counts megabytes to one decimal, because papers are megabytes", () => {
    expect(formatBytes(11.4 * MB)).toBe("11.4 MB");
    expect(formatBytes(3.24 * MB)).toBe("3.2 MB");
  });
});

describe("bytesProgress", () => {
  it("reads as a distance travelled", () => {
    expect(bytesProgress(3.2 * MB, 11.4 * MB)).toBe("3.2 MB of 11.4 MB");
  });
  it("says what it can when the total is not known", () => {
    // `lengthComputable === false`, and a browser that also withheld the size.
    expect(bytesProgress(2 * MB, 0)).toBe("2 MB sent");
  });
  it("does not divide by an empty file", () => {
    expect(bytesProgress(0, 0)).toBe("0 B sent");
    expect(percentSent(0, 0)).toBeNull();
  });
});

describe("percentSent", () => {
  it("rounds to whole percent", () => {
    expect(percentSent(MB, 4 * MB)).toBe(25);
    expect(percentSent(1, 3)).toBe(33);
  });
  it("never reports past the end", () => {
    expect(percentSent(5 * MB, 4 * MB)).toBe(100);
  });
});

describe("isCancellation", () => {
  it("recognises the platform's own withdrawal", () => {
    expect(isCancellation({ name: "AbortError" })).toBe(true);
    expect(isCancellation(new DOMException("gone", "AbortError"))).toBe(true);
  });
  it("does not swallow a real failure", () => {
    expect(isCancellation(new Error("Upload failed with status 500."))).toBe(false);
    expect(isCancellation(null)).toBe(false);
    expect(isCancellation("AbortError")).toBe(false);
  });
});

describe("cancelOffer", () => {
  it("offers a real abort while bytes or pages are moving", () => {
    expect(cancelOffer({ kind: "reading", pagesDone: 4, pageCount: 340 })).toEqual({
      kind: "abort",
      label: "Stop reading it",
    });
    expect(cancelOffer({ kind: "sending", loaded: 0, total: MB })).toEqual({
      kind: "abort",
      label: "Cancel the upload",
    });
  });
  it("offers an honest abandon where there is nothing left to abort", () => {
    // The mutation is one round trip and cannot be recalled; what can be given
    // back is the form and the truth about what may have landed.
    expect(cancelOffer({ kind: "filing" })).toEqual({
      kind: "abandon",
      label: "Stop waiting",
    });
  });
  it("offers nothing where nothing is happening", () => {
    expect(cancelOffer({ kind: "empty" })).toBeNull();
    expect(cancelOffer({ kind: "read" })).toBeNull();
  });
  it("leaves no waiting stage unabandonable", () => {
    for (const stage of [
      { kind: "reading", pagesDone: 0, pageCount: 0 },
      { kind: "sending", loaded: 0, total: 0 },
      { kind: "filing" },
    ] as const) {
      expect(cancelOffer(stage)).not.toBeNull();
    }
  });
});

describe("stageProgress", () => {
  it("counts pages before the file has opened, and after", () => {
    expect(stageProgress({ kind: "reading", pagesDone: 0, pageCount: 0 })).toBe(
      "Opening the PDF…",
    );
    expect(stageProgress({ kind: "reading", pagesDone: 4, pageCount: 12 })).toBe(
      "Reading page 4 of 12…",
    );
  });
  it("counts bytes while they move", () => {
    expect(stageProgress({ kind: "sending", loaded: 3.2 * MB, total: 11.4 * MB })).toBe(
      "3.2 MB of 11.4 MB",
    );
  });
  it("says what the last wait is for", () => {
    expect(stageProgress({ kind: "filing" })).toBe("Filing it…");
  });
  it("has nothing to say when nothing is in flight", () => {
    expect(stageProgress({ kind: "read" })).toBeNull();
    expect(stageProgress({ kind: "empty" })).toBeNull();
  });
});

describe("stageAnnouncement", () => {
  it("changes once per stage, not once per page or per chunk", () => {
    const reading = [
      stageAnnouncement({ kind: "reading", pagesDone: 1, pageCount: 340 }),
      stageAnnouncement({ kind: "reading", pagesDone: 339, pageCount: 340 }),
    ];
    expect(reading[0]).toBe(reading[1]);
    expect(reading[0]).toBe("Reading the PDF.");
    expect(stageAnnouncement({ kind: "sending", loaded: 1, total: 2 })).toBe(
      "Uploading the PDF.",
    );
    expect(stageAnnouncement({ kind: "filing" })).toBe("Adding the paper.");
    expect(stageAnnouncement({ kind: "read" })).toBe("");
  });
});
```

- [ ] **Step 2: Run it** — `npx vitest run "app/(app)/app/library/_components/upload-flow.test.ts"` — FAIL (module missing).

- [ ] **Step 3: Implement the core**

```ts
// app/(app)/app/library/_components/upload-flow.ts

/**
 * What an upload has to say for itself while it happens.
 *
 * All of it is here rather than in the component for the reason the reader's
 * `zoom.ts` and `draft-box.ts` are: this harness has no DOM, so a rule written
 * inside JSX is a rule with no test. The three that matter are testable and
 * were all wrong before — a wait with no way out of it, a byte count that
 * divided by an empty file, and a live region that fired once per page.
 */

/** One decimal from a megabyte up, whole units below: nobody reads "3.247 MB". */
export function formatBytes(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  if (bytes >= MB) {
    return `${(bytes / MB).toFixed(1)} MB`;
  }
  if (bytes >= KB) {
    return `${Math.round(bytes / KB)} KB`;
  }
  return `${Math.round(bytes)} B`;
}

/**
 * A distance, not a fraction. `total` can genuinely be unknown — an XHR
 * progress event may arrive with `lengthComputable === false` — and "3.2 MB of
 * 0 MB" is worse than saying only the half that is true.
 */
export function bytesProgress(loaded: number, total: number): string {
  return total > 0
    ? `${formatBytes(loaded)} of ${formatBytes(total)}`
    : `${formatBytes(loaded)} sent`;
}

/** For `aria-valuenow`. `null` where there is no denominator to divide by. */
export function percentSent(loaded: number, total: number): number | null {
  if (!(total > 0)) {
    return null;
  }
  return Math.min(100, Math.round((loaded / total) * 100));
}

/**
 * The member called it off, and that is not a failure to report.
 *
 * Both withdrawals speak the platform's own vocabulary — `xhr.abort()` and
 * `AbortSignal.throwIfAborted()` both surface as an `AbortError` — so one
 * predicate covers the network leg and the pdf.js leg. `instanceof` is not
 * available: pdf.js's exceptions cross a worker boundary and arrive with their
 * prototype flattened, which is why `describePdfOpenError` reads `name` too.
 */
export function isCancellation(caught: unknown): boolean {
  return (
    typeof caught === "object" &&
    caught !== null &&
    "name" in caught &&
    (caught as { name: unknown }).name === "AbortError"
  );
}

/** Where the upload has got to. The component widens this with the file. */
export type UploadStage =
  | { kind: "empty" }
  | { kind: "reading"; pagesDone: number; pageCount: number }
  | { kind: "read" }
  | { kind: "sending"; loaded: number; total: number }
  | { kind: "filing" };

/**
 * No wait without a way out of it.
 *
 * A 400-page scan used to wedge this tab until the page was reloaded: neither
 * `reading` nor `saving` rendered a single control. Two of the three waits can
 * be genuinely stopped — pdf.js between pages, the XHR at any byte. The third
 * cannot: `createFromUpload` is one round trip and there is no recalling it.
 * What can be given back there is the form and an honest sentence about what
 * may have landed, which is what "abandon" means and why it is not called
 * "cancel".
 */
export function cancelOffer(
  stage: UploadStage,
): { kind: "abort" | "abandon"; label: string } | null {
  switch (stage.kind) {
    case "reading":
      return { kind: "abort", label: "Stop reading it" };
    case "sending":
      return { kind: "abort", label: "Cancel the upload" };
    case "filing":
      return { kind: "abandon", label: "Stop waiting" };
    default:
      return null;
  }
}

/** The running count, for eyes. Not announced — see `stageAnnouncement`. */
export function stageProgress(stage: UploadStage): string | null {
  switch (stage.kind) {
    case "reading":
      return stage.pageCount === 0
        ? "Opening the PDF…"
        : `Reading page ${stage.pagesDone} of ${stage.pageCount}…`;
    case "sending":
      return bytesProgress(stage.loaded, stage.total);
    case "filing":
      return "Filing it…";
    default:
      return null;
  }
}

/**
 * The same news, once per stage.
 *
 * The old progress line was `aria-live="polite"` and rewritten once per page,
 * so a 340-page scan queued 340 announcements; a byte counter would queue one
 * per chunk. The count stays on screen, in a `progressbar` a screen reader can
 * ask for; this is the only thing that ever speaks, and it changes three times.
 */
export function stageAnnouncement(stage: UploadStage): string {
  switch (stage.kind) {
    case "reading":
      return "Reading the PDF.";
    case "sending":
      return "Uploading the PDF.";
    case "filing":
      return "Adding the paper.";
    default:
      return "";
  }
}
```

- [ ] **Step 4: Run it** — `npx vitest run "app/(app)/app/library/_components/upload-flow.test.ts"` — PASS.

- [ ] **Step 5: Move the transport to XHR.** Replace `uploadPdf` in `pdf-ingest.ts` (:1–28, keeping `titleFromFilename` and `parseAuthors` below it untouched):

```ts
import type { Id } from "@/convex/_generated/dataModel";

export type UploadOptions = {
  /** Bytes sent, and the file's size — called many times a second. */
  onProgress?: (loaded: number, total: number) => void;
  /** Withdraw the upload. Rejects with the signal's reason, an `AbortError`. */
  signal?: AbortSignal;
};

/**
 * The upload half of ingest: the browser POSTs the file straight to the URL
 * Convex minted for it, and the function it calls afterwards only ever sees
 * the resulting storage id. Nothing the size of a PDF passes through a Convex
 * function argument.
 *
 * `XMLHttpRequest`, in 2026, and on purpose. `fetch` cannot report a request
 * body's progress in any browser — there is no event and no readable
 * counterpart to `Response.body` for the request side — and a member watching
 * a 40 MB scan go up deserves better than a sentence that does not move.
 * `xhr.upload.progress` is the only cross-browser answer, and `xhr.abort()`
 * comes with it, so the ceremony below buys both halves at once.
 */
export function uploadPdf(
  uploadUrl: string,
  file: File,
  { onProgress, signal }: UploadOptions = {},
): Promise<Id<"_storage">> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();

    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadUrl);
    // Declared, not forwarded. `file.type` is whatever the OS guessed from
    // the extension and is routinely blank or `application/octet-stream` for
    // a perfectly good PDF — and the stored content type is what the mutation
    // checks before it will let a paper point at this blob. By here pdf.js has
    // already parsed the file, which is better evidence than the guess.
    xhr.setRequestHeader("Content-Type", "application/pdf");

    xhr.upload.addEventListener("progress", (event) => {
      // The size is known from the `File` regardless, so a browser withholding
      // `lengthComputable` costs the readout nothing.
      onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
    });

    xhr.addEventListener("load", () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Upload failed with status ${xhr.status}.`));
        return;
      }
      try {
        const body = JSON.parse(xhr.responseText) as { storageId: Id<"_storage"> };
        resolve(body.storageId);
      } catch {
        reject(new Error("The upload finished, but Margin couldn't read the reply."));
      }
    });

    xhr.addEventListener("error", () =>
      reject(new Error("The upload didn't reach the server.")),
    );
    xhr.addEventListener("abort", () =>
      reject(signal?.reason ?? new DOMException("Upload cancelled.", "AbortError")),
    );

    // A cancel that lands after the response did is a no-op here — the promise
    // has already settled. The caller re-reads `signal.aborted` afterwards and
    // discards the blob, because a file nothing points at is never found again.
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });

    xhr.send(file);
  });
}
```

- [ ] **Step 6: Let pdf.js be stopped.** In `lib/pdf/extract.ts`, extend `ExtractOptions` (:38–41):

```ts
export type ExtractOptions = {
  /** Called after each page. Papers are short but scans are slow; the UI shows a count. */
  onProgress?: (pagesDone: number, pageCount: number) => void;
  /**
   * Withdraw the read. Checked between pages, which is the finest grain
   * available — one page's `getTextContent` is a single worker round trip and
   * is not interruptible — and honoured by the `finally` below, which destroys
   * the loading task whichever way this ends. Optional and additive: the two
   * callers that never cancel are unchanged by it.
   */
  signal?: AbortSignal;
};
```

and add one line at the top of the page loop (:171–174):

```ts
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      options.signal?.throwIfAborted();
      pages.push(await extractPageText(doc, pageNumber));
      options.onProgress?.(pageNumber, pageCount);
    }
```

Also add `options.signal?.throwIfAborted();` as the first statement of `extractPdf` (before `await loadPdfjs()`), so a cancel that lands during the ~1 MB dynamic import does not go on to open the document.

- [ ] **Step 7: Rework `UploadTab`.** In `add-paper.tsx`, replace the `UploadPhase` type (~:304–308) and the whole of `UploadTab` (~:310–421).

The phase now carries the file through the two save stages, because the form must not unmount while they run:

```tsx
/**
 * The file is carried through `sending` and `filing`, not dropped at the door.
 *
 * `ConfirmUpload` used to be rendered only in `read`, so submitting unmounted
 * it and a failure remounted it — with its `useState` initialisers re-deriving
 * title and authors from the PDF's own metadata. A title the member had
 * corrected by hand was silently replaced by `Microsoft Word - draft3.doc` at
 * the exact moment they were being told to try again. Keeping the same element
 * in the same slot across all three stages is the fix: the component never
 * unmounts, so there is no state to lose and nothing to hoist.
 */
type UploadPhase =
  | { kind: "empty" }
  | { kind: "reading"; pagesDone: number; pageCount: number }
  | { kind: "read"; file: File; extraction: PdfExtraction }
  | { kind: "sending"; file: File; extraction: PdfExtraction; loaded: number; total: number }
  | { kind: "filing"; file: File; extraction: PdfExtraction };

function UploadTab({ labId }: { labId: Id<"labs"> }) {
  const generateUploadUrl = useMutation(api.papers.generateUploadUrl);
  const createFromUpload = useMutation(api.papers.createFromUpload);
  const discardUpload = useMutation(api.papers.discardUpload);
  const router = useRouter();

  const [phase, setPhase] = useState<UploadPhase>({ kind: "empty" });
  const [error, setError] = useState<string | null>(null);
  /** Not an error: what a withdrawal left behind, in the member's own words. */
  const [note, setNote] = useState<string | null>(null);

  /** Whatever is currently in flight, so the cancel control has something to pull. */
  const inFlight = useRef<AbortController | null>(null);
  /**
   * Which submit is allowed to speak. An abandoned `filing` leaves a mutation
   * running that will resolve into a component that has moved on; without this
   * it would navigate away from a form the member had gone back to.
   */
  const attempt = useRef(0);

  async function read(file: File) {
    setError(null);
    setNote(null);
    const controller = new AbortController();
    inFlight.current = controller;
    setPhase({ kind: "reading", pagesDone: 0, pageCount: 0 });
    try {
      const extraction = await extractPdfFile(file, {
        signal: controller.signal,
        onProgress: (pagesDone, pageCount) =>
          setPhase({ kind: "reading", pagesDone, pageCount }),
      });
      setPhase({ kind: "read", file, extraction });
    } catch (caught) {
      setPhase({ kind: "empty" });
      if (isCancellation(caught)) {
        setNote("Stopped. Nothing was read and nothing was sent.");
        return;
      }
      setError(
        describePdfOpenError(caught) ??
          "Margin couldn't read that PDF. If it opens elsewhere, it may be encrypted — try re-saving it and dropping it in again.",
      );
    } finally {
      inFlight.current = null;
    }
  }

  async function submit(file: File, extraction: PdfExtraction, title: string, authors: string[]) {
    setError(null);
    setNote(null);
    const mine = ++attempt.current;
    const controller = new AbortController();
    inFlight.current = controller;
    setPhase({ kind: "sending", file, extraction, loaded: 0, total: file.size });

    // The upload and the paper are two round trips. If the second one fails,
    // the file is already sitting in storage with nothing pointing at it — and
    // nothing will ever find it again.
    let uploaded: Id<"_storage"> | null = null;
    try {
      const uploadUrl = await generateUploadUrl({ labId });
      uploaded = await uploadPdf(uploadUrl, file, {
        signal: controller.signal,
        onProgress: (loaded, total) =>
          setPhase({ kind: "sending", file, extraction, loaded, total }),
      });
      // The abort raced the response and lost. The bytes are in storage all
      // the same, so they get discarded rather than orphaned.
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      setPhase({ kind: "filing", file, extraction });
      const paperId = await createFromUpload({
        labId,
        storageId: uploaded,
        title,
        authors: authors.length > 0 ? authors : undefined,
        pages: extraction.pages,
      });
      if (attempt.current !== mine) {
        return;
      }
      router.push(`/app/library/${paperId}`);
    } catch (caught) {
      if (attempt.current !== mine) {
        return;
      }
      setPhase({ kind: "read", file, extraction });
      if (isCancellation(caught)) {
        setNote("Cancelled. Nothing was added, and the file is still here.");
      } else {
        setError(readableError(caught, "We couldn't add that paper. Try again."));
      }
      if (uploaded !== null) {
        try {
          await discardUpload({ labId, storageId: uploaded });
        } catch {
          // Best effort. The member has already been told what happened; a
          // failed clean-up is not a second thing to say.
        }
      }
    } finally {
      inFlight.current = null;
    }
  }

  const offer = cancelOffer(phase);

  function withdraw() {
    if (offer === null) {
      return;
    }
    if (offer.kind === "abort") {
      inFlight.current?.abort();
      return;
    }
    // Nothing to abort: `createFromUpload` is one round trip and cannot be
    // recalled. What can be handed back is the form and the truth.
    attempt.current += 1;
    if (phase.kind === "filing") {
      setPhase({ kind: "read", file: phase.file, extraction: phase.extraction });
    }
    setNote(
      "Stopped waiting. If it did land, the paper is on the shelf already — look before adding it again.",
    );
  }

  const progress = stageProgress(phase);

  return (
    <div
      role="tabpanel"
      id="add-paper-panel-upload"
      aria-labelledby="add-paper-tab-upload"
      tabIndex={0}
      className="flex flex-col gap-4"
    >
      {phase.kind === "empty" && (
        <>
          <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
            The text layer is read here in your browser — the file goes to your
            lab, and nothing else does.
          </p>
          <PdfDropzone
            id="add-paper-file"
            hint="Margin reads it here, then stores it for the lab."
            onFile={read}
          />
        </>
      )}

      {phase.kind === "reading" && (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <Progress phase={phase} />
          <CancelControl offer={offer} onWithdraw={withdraw} />
        </div>
      )}

      {/* One slot, three stages. The element position must not change between
          them: React keeps this component's state only while it keeps the same
          place in the tree, and its state is the member's typing. */}
      {(phase.kind === "read" ||
        phase.kind === "sending" ||
        phase.kind === "filing") && (
        <ConfirmUpload
          file={phase.file}
          extraction={phase.extraction}
          busy={phase.kind !== "read"}
          progress={progress === null ? null : <Progress phase={phase} />}
          cancel={<CancelControl offer={offer} onWithdraw={withdraw} />}
          onStartOver={() => {
            // A failure that is still on screen under a fresh dropzone is a
            // failure about a file that is no longer there.
            setError(null);
            setNote(null);
            setPhase({ kind: "empty" });
          }}
          onSubmit={(title, authors) =>
            submit(phase.file, phase.extraction, title, authors)
          }
        />
      )}

      {/* The only thing that speaks. See `stageAnnouncement`. */}
      <p className="sr-only" aria-live="polite">
        {stageAnnouncement(phase)}
      </p>

      {note !== null && (
        <p className="font-sans text-sm text-ink-muted">{note}</p>
      )}
      {error !== null && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The count, for eyes and for anyone who asks for it — and for nobody who
 * didn't. A `progressbar` is polled rather than announced, which is the whole
 * difference between a readout and 340 interruptions.
 */
function Progress({ phase }: { phase: UploadPhase }) {
  const text = stageProgress(phase);
  if (text === null) {
    return null;
  }
  const percent = phase.kind === "sending" ? percentSent(phase.loaded, phase.total) : null;
  return (
    <p
      role="progressbar"
      aria-valuetext={text}
      {...(percent === null
        ? {}
        : { "aria-valuenow": percent, "aria-valuemin": 0, "aria-valuemax": 100 })}
      className="font-sans text-sm tabular-nums text-ink-muted"
    >
      {text}
    </p>
  );
}

function CancelControl({
  offer,
  onWithdraw,
}: {
  offer: { kind: "abort" | "abandon"; label: string } | null;
  onWithdraw: () => void;
}) {
  if (offer === null) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={onWithdraw}
      className={`${linkButtonClass} tap-target text-xs`}
    >
      {offer.label}
    </button>
  );
}
```

Update the imports at the top of `add-paper.tsx`: add `useRef` to the `react` import; add `linkButtonClass` to the `@/lib/ui` import; add `import { cancelOffer, isCancellation, percentSent, stageAnnouncement, stageProgress } from "./upload-flow";`.

- [ ] **Step 8: Keep the form on screen through the save.** Replace `ConfirmUpload`'s signature and its button row (`add-paper.tsx` ~:423–505). The doc block is new and load-bearing:

```tsx
/**
 * The fields, and they stay put.
 *
 * This form used to be rendered only while the phase was `read`, so submitting
 * unmounted it and a failed save remounted it — re-deriving title and authors
 * from the PDF's metadata and throwing away whatever the member had typed, at
 * the one moment they were being asked to try again. It now stays mounted
 * through the upload and the save, disabled rather than gone: the corrections
 * are still on screen while the bytes move, and still there if they don't land.
 * That is also where the cancel control has to live, because this is the only
 * thing on screen during the wait.
 */
function ConfirmUpload({
  file,
  extraction,
  busy,
  progress,
  cancel,
  onStartOver,
  onSubmit,
}: {
  file: File;
  extraction: PdfExtraction;
  busy: boolean;
  progress: ReactNode;
  cancel: ReactNode;
  onStartOver: () => void;
  onSubmit: (title: string, authors: string[]) => Promise<void>;
}) {
```

Add `import type { ReactNode } from "react";` (or fold `ReactNode` into the existing type-only import). Give both `<input>`s `disabled={busy}` (`paper-title` ~:468–475 and `paper-authors` ~:480–488), and replace the button row (~:491–502) with:

```tsx
      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          {busy ? "Adding…" : "Add to library"}
        </button>
        {busy ? (
          cancel
        ) : (
          <button
            type="button"
            onClick={onStartOver}
            className={secondaryButtonClass}
          >
            Choose another file
          </button>
        )}
        {progress}
      </div>
```

- [ ] **Step 9: The second call site.** `pdf-panel.tsx`'s `attach` (~:138–172) is the other `uploadPdf` caller and has the same two waits with no way out. Give it a controller, thread it into both legs, and stop announcing every page:

Add to the component's state (~:59–62) — **state, not a ref**, for both: the cancel control's presence is decided during render, and a ref written inside `attach` would leave the button on screen after the attach ended and off it while one ran. No import change is needed; `pdf-panel.tsx:18` already brings in `useState`.

```tsx
  /** The live attach, so the wait has something to pull. */
  const [attaching, setAttaching] = useState<AbortController | null>(null);
  /** Bytes on the way up, for `aria-valuenow`. Null outside the upload leg. */
  const [sending, setSending] = useState<{ loaded: number; total: number } | null>(null);
```

Then:

```tsx
  async function attach(file: File) {
    setError(null);
    const controller = new AbortController();
    setAttaching(controller);
    // Held outside the `try` so the catch knows whether a file made it into
    // storage before things went wrong.
    let uploaded: Id<"_storage"> | null = null;
    try {
      setStatus("Reading the PDF…");
      const extraction = await extractPdfFile(file, {
        signal: controller.signal,
        onProgress: (pagesDone, pages) =>
          setStatus(`Reading page ${pagesDone} of ${pages}…`),
      });
      setStatus("Storing it for the lab…");
      setSending({ loaded: 0, total: file.size });
      const uploadUrl = await generateUploadUrl({ labId });
      uploaded = await uploadPdf(uploadUrl, file, {
        signal: controller.signal,
        onProgress: (loaded, total) => {
          setSending({ loaded, total });
          setStatus(bytesProgress(loaded, total));
        },
      });
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      // The control goes before the last leg rather than sitting there dead:
      // `attachPdf` is one round trip and there is nothing left to abort.
      setAttaching(null);
      setSending(null);
      setStatus("Filing it…");
      await attachPdf({ paperId, storageId: uploaded, pages: extraction.pages });
      // The paper owns the file now; it is not an orphan any more.
      uploaded = null;
      setStatus(null);
    } catch (caught) {
      setStatus(null);
      // A withdrawal is not a verdict on the file. It leaves the paper exactly
      // as it was, so nothing is marked failed — only the blob goes, if one
      // got as far as storage before the abort landed.
      if (isCancellation(caught)) {
        if (uploaded !== null) {
          try {
            await discardUpload({ labId, storageId: uploaded });
          } catch {
            // The blob outlives us. Nothing the member can do about it.
          }
        }
        return;
      }
      // This catch covers the whole attach, not just the read: an upload or a
      // mutation can fail here too, and those arrive as `ConvexError`s whose
      // message is the one worth showing. So ask pdf.js's classifier first —
      // it only answers for the failures it recognises — and fall through to
      // `readableError` for everything else.
      const message =
        describePdfOpenError(caught) ??
        readableError(
          caught,
          "Margin couldn't read that PDF. If it opens elsewhere, it may be encrypted.",
        );
      setError(message);
      await recover(uploaded, message);
    } finally {
      setAttaching(null);
      setSending(null);
    }
  }
```

And replace the busy line (~:360–364) — it was `aria-live="polite"` and rewritten once per page:

```tsx
      {busyMessage !== null && (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          {/* Not a live region. It used to be, and a 340-page scan queued 340
              announcements; the count is here to be looked at, and the
              `progressbar` role is what lets it be asked for instead. */}
          <p
            role="progressbar"
            aria-valuetext={busyMessage}
            {...(sending === null
              ? {}
              : (() => {
                  const percent = percentSent(sending.loaded, sending.total);
                  return percent === null
                    ? {}
                    : { "aria-valuenow": percent, "aria-valuemin": 0, "aria-valuemax": 100 };
                })())}
            className="font-sans text-sm tabular-nums text-ink-muted"
          >
            {busyMessage}
          </p>
          {attaching !== null && (
            <button
              type="button"
              onClick={() => attaching.abort()}
              className={`${linkButtonClass} tap-target text-xs`}
            >
              Stop attaching it
            </button>
          )}
        </div>
      )}
```

Add `import { bytesProgress, isCancellation, percentSent } from "./upload-flow";` to `pdf-panel.tsx`.

- [ ] **Step 10: Whole suite, typecheck, lint** — `npx vitest run && npx tsc --noEmit && npm run lint` — PASS, with **65 test files** and the 1181 baseline tests still green. `npx vitest run "app/(app)/app/library/_components/press-grammar.test.ts"` must still pass: `pdf-panel.tsx` and `add-paper.tsx` keep their `pressable` from Task 2 and this task adds no `duration-200`.

- [ ] **Step 11: Commit.**

```bash
git add "app/(app)/app/library/_components/upload-flow.ts" \
        "app/(app)/app/library/_components/upload-flow.test.ts" \
        "app/(app)/app/library/_components/pdf-ingest.ts" \
        "app/(app)/app/library/_components/add-paper.tsx" \
        "app/(app)/app/library/_components/pdf-panel.tsx" \
        lib/pdf/extract.ts
git commit -m "Upload: bytes on the way up, a way to call it off, and edits that survive a failure

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of scope — flagged, deliberately not fixed here

These are real and they are not this PR. Carry them to the final review's backlog list rather than fixing them:

- **F6** — switching add-paper tabs unmounts the other panel and destroys in-flight work with no warning (`add-paper.tsx:49, 78–84`). A PDF sitting in `ConfirmUpload` is thrown away by a click on `By DOI`. Task 3 makes this *more* costly, not less, because there is now more state worth keeping; it still needs its own decision about whether a tab switch should be refused, warned, or made non-destructive.
- **F9 beyond Task 2** — nothing further. Task 2 already presses `TabButton` and `PdfDropzone`.
- **F10** — `tap-target` boxes overlap in the shelf row (`page.tsx:389`, `gap-x-4` between two 44px boxes; `globals.css:344–349` warns about exactly this). Pre-existing; Task 1 and Task 2 must not widen the gap or add a third box to that row, but fixing the rhythm is separate.
- **F11** — `onAdded` is not passed to `UploadTab` (`add-paper.tsx:81`), unlike the other two tabs. Still harmless after Task 3 because the upload path still navigates away on success; it becomes load-bearing the moment upload stays on the shelf.
- **F12** — `markedIndex` can be `-1` with an empty `shown` (`page.tsx:119–121`). Not a live bug; the call sites guard. Do not "fix" it — it would change keyboard behaviour.
- **The `aria-live` on `DoiOutcome`** (`add-paper.tsx:285`) is rewritten once per page during a DOI-path extraction, which is F5 on a third surface. It carries its own comment defending the live region for a different reason and belongs to the DOI path, not the upload path.
- **A `quietLinkButtonClass` export.** Several in-lane controls share `text-xs text-ink-faint underline-offset-4 hover:text-accent hover:underline` and `ConfirmAction` has a `toneClass.faint` saying the same thing. Adding a second export is right and is not this PR — the fence expansion above is deliberately one class and one line.
- Anything in the reader, anything in `convex/papers.ts` (nothing here needs a server change; `discardUpload` already exists for the cancel-cleanup case), and any other timeline item.

## Manual browser pass (after final review, before PR)

Nothing in this plan's browser-only behaviour can be proven by CI: `vitest` runs in a node environment with no DOM, and `playwright.config.ts:13–19` points the built app at an unreachable `NEXT_PUBLIC_CONVEX_URL` on purpose, so no e2e test can sign in or reach the library at all. Run these against a real deployment:

1. **Upload progress across CORS.** The upload URL is cross-origin (`*.convex.cloud`, minted by `convex/papers.ts:278–285`) and the explicit `Content-Type` already forces a preflight today, so attaching upload listeners introduces no new one — but cross-origin `xhr.upload` progress events only fire once the CORS check passes. Upload a file large enough to take a few seconds and confirm the byte count actually moves rather than jumping 0 → 100.
2. **Cancel mid-upload.** Press `Cancel the upload` while bytes are moving: the form comes back with the typed title intact, the note says nothing was added, no error alert appears, and no paper lands on the shelf.
3. **Cancel mid-read.** Drop a large scan and press `Stop reading it`: the dropzone comes back within a page or two of work, not at the end of the document.
4. **A failed save keeps the edits.** Correct the title by hand, break the network, submit: the error appears *under a form still showing the corrected title*.
5. **`Stop waiting` during `filing`.** The form returns and the sentence tells the truth about the paper possibly having landed.
6. **Screen reader.** A 300-page scan announces three times, not three hundred; the count is reachable as a progress bar.
7. Task 1's row items and Task 2's press items, listed at the end of each task.
