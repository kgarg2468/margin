# C4 + C5 — Surfaces, and the boundary the brief stopped at: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the scout visible and usable, and let the brief say the one thing it has never been able to say. C4 puts the finding under the carried-forward question that provoked it, gives the outcomes panel a status chip and a finding card, and records `findingId` provenance when a human settles a question with a machine's report in front of them. C5 lifts `lib/brief/assemble.ts` past the paper boundary that `#56` already lifted in the digest, so "two people made the same claim in two different papers" reaches a presenter's agenda. Both land in one PR because both touch the same three files.

**Architecture:** Nothing new is written to the database except one provenance field. C3 (#76) shipped every read these surfaces need — `findings.newestForSubject`, `findings.forDelegation`, `delegations.listForSubject`, and a `findingView` that re-resolves every citation on every read — and the surfaces consume exactly those. Every rule a component could get wrong lives in a pure `lib/` module with a vitest suite beside it (`lib/scout/surface.ts`, `lib/scout/adopt.ts`, `lib/brief/prep.ts`), because this repo has no React test harness and never will: `vitest.config.mts` includes `.ts` only, "a test that needed to render would belong in `e2e/`". The components stay thin enough to check by eye. C5 is the same shape as the digest's lift — `detectCrossPaperCollisions` is already written, already capped, already tested; the work is a pool, a merge rule, and one honest field so the browser can tell a far citation from a withdrawn one.

**Tech Stack:** Next.js 15 App Router (client components), Convex (default runtime), Tailwind v4 with the semantic tokens in `app/globals.css`, vitest (node env), TypeScript `strict` + `noUncheckedIndexedAccess` + `noUnusedLocals`, Playwright for the browser pass.

## Global Constraints

These are the fence. No task moves them.

- **UI via `lib/ui` classes.** `chipClass`, `linkButtonClass`, `secondaryButtonClass`, `eyebrowClass`, `errorClass`, `skeletonClass` — a control that needs a new look gets it there, not inline at a call site.
- **Pressable press grammar: pointerdown, compositor-only.** Anything pressable wears the `pressable` utility; nothing new animates layout, colour is the only property that eases outside `transform`.
- **`useQuery` comes from `convex-helpers/react/cache/hooks`,** never from `convex/react`. This is eslint-enforced.
- **Comments carry reasoning, never restate code.** Every non-obvious line says *why*, in the voice of the file it lands in. A comment that paraphrases the statement under it is worse than none.
- **No pricing or monetization content** anywhere — not in copy, not in a comment.
- **Ledger events only via `recordEvent()`.** No prose in an event: ids, counts, and closed-vocabulary reasons.
- **Findings render ONLY citable text.** A redacted item shows its redaction sentence and nothing else — never a hint of what was behind it, never a partial line, never the ids dressed up as content.
- **The brief section is reactive and never blocks or delays the brief itself.** The brief renders on its own subscription; a finding arrives underneath it when it arrives, and a pending, empty, failed or absent run costs the brief nothing.
- **Commits end with:** `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- `npm test`, `npx tsc --noEmit`, `npm run typecheck:convex`, and `npm run lint` all pass at every commit.
- `lib/` imports nothing from `convex/` — not `convex/values`, not `_generated`. Pure modules are generic over id strings.

## Decisions settled here, so no task re-litigates them

1. **Inline `[A#]` markers are stripped, not renumbered.** The scout's prompt (`convex/delegations.ts:1203`) tells the model to write `[A1]` inside its prose, and `findings` stores that prose verbatim. The label→row map is per-run and is **not stored** — `findings.items[].citedAnnotationIds` is a flat array whose order comes from `[...scanLabels(citations), ...scanLabels(text)]`, so there is no way to map `A3` back to a row at render time and any attempt would be a guess dressed as a citation. Markers therefore come out of the sentence, and the citations render beneath it as the notes they are. Task 1 is what makes that removal total.
2. **A finding's citations are never numbered "Note N".** The brief already owns one document-wide numbering registry (`citationNumbering`), and a finding's citations are lab-wide — a second registry on the same page would make "Note 3" mean two things. Findings cite by author and page, linked into the reader; the ones this page cannot resolve are counted, not named.
3. **The finding card applies no client-side redaction test.** `brief.tsx` re-checks its lines against the paper's own margin because every brief citation is on that paper. A finding's are not — the gather searches `annotations.search_body` lab-wide — so "not in my rows" means "another paper" far more often than "withdrawn", and a client that treated the two the same would blank the whole feature. `findings.toView` is the defense of record and is documented as such (`convex/findings.ts:18-36`). The card says so in a comment and trusts it.
4. **The outcomes panel's chips and card are written against action subjects and are empty in v1 by construction.** `delegations.listForSubject({kind:"action"})` returns `[]` until v1.5's on-demand runs exist. They are not dead code: the same components render the brief's annotation subjects, where there is real data on dev today. An action row does **not** borrow the finding on its `citedAnnotationId` — a report about a note is not a report about the outcome recorded from it, and inferring otherwise would put a machine's paraphrase under a question it never read.
5. **The failure vocabulary is C3's, not design §7's.** §7 asks for "Scout searched N annotations across M papers and found nothing citable" on empty/failed runs, but `coverage` lives on a `findings` row and no row is written for `empty` or `failed` (`convex/delegations.ts:2469`, `markFailed`). The reader's sentence for a failure is `delegationView.failureReason`, which C3 already wrote by hand (`FAILURE_SENTENCES`, `convex/delegations.ts:2535`). The coverage sentence belongs where coverage exists: under a *returned* finding.
6. **C5's cross-paper scan runs over the lab's recent papers, capped.** Twelve papers besides this one, 150 annotations each, on top of the session paper's existing 1000. Named constants with the arithmetic in a comment. Only pairs with exactly one side on the session's paper survive: a brief is about *this* meeting's paper, and a line about two other documents is somebody else's agenda.

**Out of scope — flag in the PR body, do not build:** v1.5 on-demand delegation and its *Delegate* button; notifications of any kind; per-viewer dismissal state; a `findings.get(findingId)` query (nothing needs one — `newestForSubject` answers from the subject); linking a cross-paper citation into the far paper's reader; unifying the two OpenAI call sites; the `sessions ↔ synthesis` import cycle.

---

### Task 1: Close the citation-marker cliff

Carried from C3's final review as the pre-C4 blocker. The label grammar is `A\d{1,4}` in two places (`normalizeLabel`, `scanLabels`). Five digits is not a longer label — it is an **invisible** one: `scanLabels("[A12345]")` returns `[]`, so `gateItems` never resolves it, never sets `sawUnknown`, and keeps the item. The unresolvable reference then sits in stored prose with nothing behind it. C3 deferred the close to C4 deliberately, because C4 is the first PR that renders that prose.

Two halves, one grammar: the gate has to *see* a marker for the item to die, and the renderer has to see the same marker for the sentence to come out clean. They are the same regex or they drift.

**Files:**
- Modify: `lib/citations/labels.ts` (`normalizeLabel` :40-45, `scanLabels` :56-66)
- Test: `lib/citations/labels.test.ts`, `lib/citations/gate.test.ts`

**Interfaces:**
- Produces: `stripLabels(text: string): string` — prose with every label taken out and the punctuation tidied behind it.
- Changes: `scanLabels` and `normalizeLabel` accept unbounded digits.
- Consumed by: Task 3 (`lib/scout/surface.ts` renders item text through `stripLabels`), and `lib/citations/gate.ts` unchanged (it already calls `scanLabels`).

- [ ] **Step 1: Write the failing tests.**

Append to `lib/citations/labels.test.ts`:

```ts
describe("the grammar has no length limit", () => {
  // The bug this closes: `A\d{1,4}` made a five-digit label invisible to the
  // scanner, so the gate never learned the item cited something nobody issued
  // and kept it — reference and all.
  it("reads a label longer than four digits, so the gate can reject it", () => {
    expect(scanLabels("the cohorts diverge [A12345]")).toEqual(["A12345"]);
  });

  it("normalizes one, rather than refusing to look at it", () => {
    expect(normalizeLabel("[A12345]")).toBe("A12345");
  });

  it("still refuses a word that merely contains digits", () => {
    expect(scanLabels("DNA12345 is not a citation")).toEqual([]);
  });
});

describe("stripLabels", () => {
  it("takes a trailing marker out and closes the gap before the stop", () => {
    expect(stripLabels("The cohort split holds [A3].")).toBe(
      "The cohort split holds.",
    );
  });

  it("takes an unbracketed one out too — the scanner reads both", () => {
    expect(stripLabels("The cohort split holds A3.")).toBe(
      "The cohort split holds.",
    );
  });

  it("takes a leading marker out and does not leave the space behind", () => {
    expect(stripLabels("[A12] the assay was rerun")).toBe(
      "the assay was rerun",
    );
  });

  it("removes the parenthesis a run of markers leaves empty", () => {
    expect(stripLabels("Both members said so (A3, A4).")).toBe(
      "Both members said so.",
    );
  });

  it("reaches a label the old grammar could not see", () => {
    expect(stripLabels("nothing issued this [A12345]")).toBe(
      "nothing issued this",
    );
  });

  it("leaves a sentence with no markers in it exactly as it was", () => {
    expect(stripLabels("Two members read the 4°C step the same way.")).toBe(
      "Two members read the 4°C step the same way.",
    );
  });
});
```

Add `stripLabels` to the import at the top of the file.

Append to `lib/citations/gate.test.ts` — the fact the whole task exists for:

```ts
  it("drops an item whose label is too long to have been issued", () => {
    // Not a length rule: `A12345` resolves to nothing, and an item citing
    // something nobody minted is dropped whole. Before the grammar was closed
    // this item survived with the reference still in its text.
    const gated = gateItems(
      [{ text: "the cohorts diverge [A12345]", citations: ["A1"] }],
      (label) => (label === "A1" ? { id: "ann_1", paperId: "p1" } : undefined),
      { maxItems: 6, maxChars: 600 },
    );
    expect(gated).not.toBeNull();
    expect(gated?.items).toEqual([]);
    expect(gated?.droppedForCitation).toBe(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npx vitest run lib/citations`
Expected: FAIL — `stripLabels is not a function`, and the two grammar tests report `[]` / `undefined` for the five-digit label.

- [ ] **Step 3: Close the grammar and add the renderer.**

In `lib/citations/labels.ts`, replace the file's regexes with one shared source and add the strip. The module doc-comment gains a paragraph; the existing prose about strict-vs-loose stays.

```ts
/**
 * The digits a label may carry: as many as were written.
 *
 * It used to be `\d{1,4}`, and that was a length limit doing a validation job.
 * A five-digit reference was not rejected by it — it was *invisible* to it, so
 * `gateItems` never resolved it, never set `sawUnknown`, and stored the item
 * with an unresolvable `[A12345]` still in the sentence. Reading it is what
 * kills it: a label nobody minted resolves to nothing and the item is dropped
 * whole. The bound was never the safety property; the resolution is.
 */
const LABEL = String.raw`A\d+`;

/** A label anywhere in prose, brackets optional. Word-bounded: `DNA12` is not one. */
const IN_PROSE = new RegExp(String.raw`\[?\b(${LABEL})\b\]?`, "g");

/**
 * The same label with whatever space runs in front of it, for taking one back
 * out of a sentence.
 *
 * Built from `LABEL` rather than written out, because the scanner and the
 * remover have to agree exactly: a marker the gate cannot see is a marker this
 * cannot remove, and that is the shape the bug above had.
 */
const IN_PROSE_WITH_SPACE = new RegExp(
  String.raw`\s*\[?\b(${LABEL})\b\]?`,
  "g",
);

/** A `refs` entry that is nothing but a label, and the leading zeros it may carry. */
const SOLE_LABEL = /^\[?\s*a\s*(\d+)\s*\]?$/i;
```

`normalizeLabel` now reads `SOLE_LABEL.exec(raw.trim())`; `scanLabels` now reads `text.matchAll(IN_PROSE)`. Both keep their existing bodies otherwise. (`matchAll` and `replace` on a `/g/` regex do not carry `lastIndex` between calls, so sharing these at module scope is safe.)

Then, at the end of the file:

```ts
/**
 * The sentence with its labels taken back out, for a reader.
 *
 * A label is a handle between this code and a model; it was never meant to be
 * read by a person, and the surfaces render citations as the notes they are
 * rather than as markers. Stripping is all that is available: the label→row
 * map is per-run and is not stored, so `[A3]` cannot be turned back into
 * "Note 3" without guessing — and a citation nobody can follow is worse than
 * no citation at all.
 *
 * The same grammar as the gate, deliberately. Every marker that survived into
 * a stored item resolved to a real row (`gateItems` drops the item otherwise),
 * so anything this removes is a citation the reader is being shown properly
 * underneath, and anything it *cannot* remove would be a hole in the gate.
 *
 * A model that used a label as a noun — "both A3 and A4 said so" — leaves an
 * awkward sentence behind. That is the right trade: an awkward sentence is a
 * reader's problem for a second, and a raw `[A12345]` is a claim the product
 * cannot support.
 */
export function stripLabels(text: string): string {
  return text
    .replace(IN_PROSE_WITH_SPACE, "")
    // The husk a parenthesised run leaves: "(A3, A4)" is emptied to "(, )".
    .replace(/\(\s*[,;·]*\s*\)/g, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `npx vitest run lib/citations convex/delegations convex/synthesis`
Expected: PASS, including the C3 suites — the grammar widening must change no behaviour for labels anyone actually issued (`MAX_CANDIDATES` is 40).

- [ ] **Step 5: Full suite + typechecks + lint.**

Run: `npm test && npx tsc --noEmit && npm run typecheck:convex && npm run lint`
Expected: all PASS.

- [ ] **Step 6: Commit.**

```bash
git add lib/citations/labels.ts lib/citations/labels.test.ts lib/citations/gate.test.ts
git commit -m "$(cat <<'EOF'
Citations: a label too long to be real is read, and refused

`A\d{1,4}` did not reject a five-digit reference, it hid one — the gate
never saw it, so the item kept both its unresolvable citation and its place.
One grammar now, read in both directions: the gate resolves what it finds,
and `stripLabels` takes the same markers back out before a reader sees prose.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: C5 — the brief consumes cross-paper collisions

`lib/brief/assemble.ts:39` says it out loud: "No cross-paper anything: `detectCollisions` stops at the paper boundary and this does not reach past it (that boundary is Phase 2's to lift)." `#56` lifted it for the digest — `detectCrossPaperCollisions`, `crossPaperOverlap`, `MIN_CROSS_PAPER_QUOTE_CHARS`, `MAX_CROSS_PAPER_COMPARISONS`, `CrossPaperScan.capped` are all shipped, capped and tested in `lib/digest/engine.test.ts`. This wires the same scan into the brief.

One honest field comes with it. `brief.tsx:538` filters an item's citations against `visibleAnnotationIds`, which is built from *this paper's* margin — so without a way to tell "on another paper" from "withdrawn", every cross-paper line would render as "A line here rested on notes that are no longer shared." The stored item says which of its citations are far, and the client defers on those to the server check that was always the one of record (`stillSharedAmong` is lab-scoped, not paper-scoped: `convex/briefs.ts:589`).

The scout gets this for free and no code says so: `gatherBriefCollisions` reads the brief's stored collision lines and re-resolves their ids lab-wide (`convex/delegations.ts:903-935`), so a cross-paper line becomes scout material the moment it exists.

**Files:**
- Modify: `lib/brief/assemble.ts` (module doc :39-45, `BriefItem` :83-113, `assembleBrief` :265-374)
- Modify: `lib/brief/prep.ts` (new `lineCitations`)
- Modify: `convex/schema.ts` (the `briefs` sections item shape)
- Modify: `convex/briefs.ts` (`briefItem` validator :92-98, `writeBrief` :217-273)
- Modify: `app/(app)/app/sessions/[sessionId]/_components/brief.tsx` (`numbering` :192-202, `BriefLine` :525-597)
- Test: `lib/brief/assemble.test.ts` (the boundary test at :153 changes meaning), `lib/brief/prep.test.ts`, `convex/briefs.test.ts`

**Interfaces:**
- Produces `lib/brief/assemble.ts`: `assembleBrief` input gains `paperId: P` (required) and `crossPaper?: { scan: CrossPaperScan<P, A, U>; paperTitles: ReadonlyMap<P, string> }`; `BriefItem` gains `crossPaperIds?: A[]`.
- Produces `lib/brief/prep.ts`: `lineCitations<A>(item, visible): { withdrawn: boolean; cited: A[] }`.
- Consumed by: `convex/briefs.ts`, `brief.tsx`, and Task 3's brief wiring.

- [ ] **Step 1: Write the failing tests.**

In `lib/brief/assemble.test.ts`, rewrite the boundary test as the *default* and add the lift beside it. The existing fixture helper `ann({...})` and `pool` shape stay as they are; `assembleBrief` calls in this file all gain `paperId: "p1"`.

```ts
import { detectCollisions, detectCrossPaperCollisions } from "../digest/engine";

const CLAIM =
  "data were collected from two independent cohorts under identical conditions";

describe("the paper boundary", () => {
  it("does not reach across it when no scan is supplied", () => {
    const pool = [
      ann({ memberId: "ana", type: "hypothesis", paperId: "p1", quote: CLAIM }),
      ann({ memberId: "ben", type: "critique", paperId: "p2", quote: CLAIM }),
    ];
    const brief = assembleBrief({
      pool,
      paperId: "p1",
      paperTitle: "This paper",
      priorSessions: new Map(),
    });
    expect(section(brief, "collisions").items).toEqual([]);
  });

  it("draws a cross-paper line when one is", () => {
    const pool = [
      ann({ memberId: "ana", type: "hypothesis", paperId: "p1", quote: CLAIM }),
      ann({ memberId: "ben", type: "critique", paperId: "p2", quote: CLAIM }),
    ];
    const brief = assembleBrief({
      pool,
      paperId: "p1",
      paperTitle: "This paper",
      priorSessions: new Map(),
      crossPaper: {
        scan: detectCrossPaperCollisions(pool),
        paperTitles: new Map([
          ["p1", "This paper"],
          ["p2", "The other one"],
        ]),
      },
    });
    const [item] = section(brief, "collisions").items;
    expect(item?.text).toContain("across This paper");
    expect(item?.text).toContain("and The other one");
    expect(item?.annotationIds).toHaveLength(2);
  });

  it("marks the far half, so a client can tell it from a withdrawal", () => {
    const near = ann({ memberId: "ana", type: "hypothesis", paperId: "p1", quote: CLAIM });
    const far = ann({ memberId: "ben", type: "critique", paperId: "p2", quote: CLAIM });
    const brief = assembleBrief({
      pool: [near, far],
      paperId: "p1",
      paperTitle: "This paper",
      priorSessions: new Map(),
      crossPaper: {
        scan: detectCrossPaperCollisions([near, far]),
        paperTitles: new Map([["p1", "This paper"], ["p2", "The other one"]]),
      },
    });
    expect(section(brief, "collisions").items[0]?.crossPaperIds).toEqual([far.id]);
  });

  it("drops a pair that touches neither side of this meeting's paper", () => {
    // Two other papers arguing with each other is somebody else's agenda.
    const a = ann({ memberId: "ana", type: "hypothesis", paperId: "p2", quote: CLAIM });
    const b = ann({ memberId: "ben", type: "critique", paperId: "p3", quote: CLAIM });
    const brief = assembleBrief({
      pool: [a, b],
      paperId: "p1",
      paperTitle: "This paper",
      priorSessions: new Map(),
      crossPaper: {
        scan: detectCrossPaperCollisions([a, b]),
        paperTitles: new Map([["p2", "Second"], ["p3", "Third"]]),
      },
    });
    expect(section(brief, "collisions").items).toEqual([]);
  });

  it("drops a line whose far paper has no title to print", () => {
    const near = ann({ memberId: "ana", type: "hypothesis", paperId: "p1", quote: CLAIM });
    const far = ann({ memberId: "ben", type: "critique", paperId: "p2", quote: CLAIM });
    const brief = assembleBrief({
      pool: [near, far],
      paperId: "p1",
      paperTitle: "This paper",
      priorSessions: new Map(),
      crossPaper: {
        scan: detectCrossPaperCollisions([near, far]),
        paperTitles: new Map([["p1", "This paper"]]),
      },
    });
    expect(section(brief, "collisions").items).toEqual([]);
  });

  it("puts every same-paper line ahead of every cross-paper one", () => {
    const same = [
      ann({ memberId: "ana", type: "hypothesis", paperId: "p1", start: 0, end: 40 }),
      ann({ memberId: "ben", type: "critique", paperId: "p1", start: 10, end: 50 }),
    ];
    const across = ann({ memberId: "cara", type: "critique", paperId: "p2", quote: CLAIM });
    const near = ann({ memberId: "ana", type: "hypothesis", paperId: "p1", quote: CLAIM });
    const pool = [...same, across, near];
    const brief = assembleBrief({
      pool,
      paperId: "p1",
      paperTitle: "This paper",
      priorSessions: new Map(),
      crossPaper: {
        scan: detectCrossPaperCollisions(pool),
        paperTitles: new Map([["p1", "This paper"], ["p2", "The other one"]]),
      },
    });
    const items = section(brief, "collisions").items;
    expect(items[0]?.crossPaperIds).toBeUndefined();
    expect(items.at(-1)?.crossPaperIds).toHaveLength(1);
  });
});
```

`section(brief, key)` is a one-line local helper if the file has none: `const section = (b: AssembledBrief, key: BriefSectionKey) => b.sections.find((s) => s.key === key)!;` — declare it beside the existing fixtures.

In `lib/brief/prep.test.ts`:

```ts
describe("lineCitations", () => {
  const visible = new Set(["a1", "a2"]);

  it("cites what this page can see", () => {
    expect(lineCitations({ annotationIds: ["a1", "a2"] }, visible)).toEqual({
      withdrawn: false,
      cited: ["a1", "a2"],
    });
  });

  it("holds a line back whole when one of its own paper's notes has gone", () => {
    expect(lineCitations({ annotationIds: ["a1", "gone"] }, visible)).toEqual({
      withdrawn: true,
      cited: [],
    });
  });

  it("defers on a citation that lives on another paper", () => {
    // The client has no rows for it and no standing to judge it. The server
    // re-resolved it lab-wide on the way out; treating absence as withdrawal
    // would blank every cross-paper line.
    expect(
      lineCitations(
        { annotationIds: ["a1", "far"], crossPaperIds: ["far"] },
        visible,
      ),
    ).toEqual({ withdrawn: false, cited: ["a1", "far"] });
  });

  it("still holds the line back when the near half has gone", () => {
    expect(
      lineCitations(
        { annotationIds: ["gone", "far"], crossPaperIds: ["far"] },
        visible,
      ),
    ).toEqual({ withdrawn: true, cited: [] });
  });
});
```

In `convex/briefs.test.ts`, add to the existing describe blocks:

```ts
describe("the brief past the paper boundary", () => {
  it("draws a line between two papers and marks the far citation", async () => {
    const ctx = new FakeCtx();
    const seed = await seedLab(ctx);
    const claim =
      "data were collected from two independent cohorts under identical conditions";
    const other = await ctx.db.insert("papers", {
      labId: seed.labId,
      title: "The other one",
      addedBy: seed.pi,
      ingestStatus: "ready",
    });
    await seedAnnotation(ctx, { ...seed, memberId: seed.pi }, {
      type: "hypothesis",
      quote: claim,
    });
    await seedAnnotation(ctx, { ...seed, memberId: seed.member }, {
      type: "critique",
      paperId: other,
      quote: claim,
    });

    ctx.auth = { userId: seed.pi };
    await handlerOf(generate)(ctx, { sessionId: seed.sessionId });

    const brief = rowAt(await ctx.db.query("briefs").collect());
    const line = brief.sections
      .find((s) => s.key === "collisions")
      ?.items.find((item) => item.crossPaperIds !== undefined);
    expect(line?.text).toContain("The other one");
    expect(line?.crossPaperIds).toHaveLength(1);
  });
});
```

`seedAnnotation`'s overrides need a `quote` key — add it to the fixture's `Partial<{...}>` and to the `anchor.quote` default (`convex/delegations.fixtures.ts:584-616`), a two-line change that belongs to this task.

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npx vitest run lib/brief convex/briefs`
Expected: FAIL — `lineCitations` undefined, `crossPaper` not a known input, `crossPaperIds` undefined on every item.

- [ ] **Step 3: Lift the boundary in the pure assembler.**

In `lib/brief/assemble.ts`, replace the "What is deliberately not here" paragraph:

```
 * ## What was deliberately not here, and now is
 *
 * Cross-paper collisions. `detectCollisions` still stops at the paper boundary
 * and always will — a collision inside one document is a *passage*, and a
 * passage has no meaning across two files. The second detector is the one that
 * crosses (`detectCrossPaperCollisions`, shipped for the digest in #56): same
 * claim, two papers, two members, gold type pair, and a sixty-character floor
 * so a methods boilerplate sentence cannot link two literatures. It arrives
 * here as an argument rather than as a call, because a pool spanning papers is
 * not on its own a request to pair across them — the same rule `assembleDigest`
 * follows.
 *
 * What is still deliberately not here: no per-item dedupe against the
 * collisions section — a "possible answer" collision is *definition ×
 * open-question*, so the open question inside it belongs in both places, and
 * hiding the second copy would cost the presenter the link between them.
```

Extend the import and the item type:

```ts
import {
  detectCollisions,
  collisionLine,
  type AnnotationType,
  type Collision,
  type CrossPaperScan,
  type DigestAnnotation,
} from "../digest/engine";
```

```ts
  /** The gold matrix cell, on collision items only — e.g. `"critique x hypothesis"`. */
  pairType?: string;
  /**
   * The citations on this line that live on a *different* paper.
   *
   * On cross-paper collision items only, and the whole reason the field
   * exists: the panel re-checks a line against the margin it has subscribed
   * to, which is this paper's. A far citation is not in that margin and never
   * will be, so without this the client's "is every note behind this line
   * still shared?" test reads a perfectly live note as a withdrawn one and
   * holds the line back — silently deleting exactly the lines this boundary
   * lift exists to draw. The server's check is lab-wide and stands
   * (`convex/briefs.ts`); this says which citations the browser must leave
   * to it.
   */
  crossPaperIds?: AnnotationId[];
```

Extend the input and build the items. The signature gains `paperId`, which the caller has and the assembler previously did without because everything was one paper:

```ts
}>(input: {
  pool: readonly BriefAnnotation<P, A, U, S>[];
  /** The paper this meeting is about. The near side of every line below. */
  paperId: P;
  paperTitle: string;
  priorSessions: ReadonlyMap<S, number>;
  collisions?: readonly Collision<P, A, U>[];
  /**
   * A cross-paper scan, and the titles to print it with.
   *
   * One field rather than two, because a scan without titles is not a weaker
   * version of this — it is a line that names one document and cites two, and
   * a reader sent to the wrong paper for half the evidence reads it as the
   * product being wrong about its own record. The type makes the pair
   * inseparable.
   */
  crossPaper?: {
    scan: CrossPaperScan<P, A, U>;
    paperTitles: ReadonlyMap<P, string>;
  };
  cap?: number;
}): AssembledBrief<A, S> {
```

Inside, after the existing `collisionItems`:

```ts
  // --- 1b. Collisions that cross a paper ----------------------------------
  // Ranked strictly below every same-paper line, which is `byPairRank`'s rule
  // in `lib/digest/engine.ts` — copied as an ordering here rather than
  // imported, because this concatenates two already-sorted lists instead of
  // re-sorting one. Scope outranks recency on purpose: the six lines a
  // presenter reads must never fill up with quote matches while two people's
  // notes on the same passage of *this* paper go unmentioned.
  const titleOf = (paperId: P): string | undefined =>
    paperId === input.paperId
      ? input.paperTitle
      : input.crossPaper?.paperTitles.get(paperId);

  const crossItems: BriefItem<A, S>[] = (
    input.crossPaper?.scan.collisions ?? []
  ).flatMap((collision) => {
    const nearTitle = titleOf(collision.a.paperId);
    const farTitle = titleOf(collision.b.paperId);
    // Exactly one side on this meeting's paper. A pair between two *other*
    // papers is a real fact and belongs in a digest, not on the agenda for a
    // meeting about neither of them.
    const touches =
      (collision.a.paperId === input.paperId) !==
      (collision.b.paperId === input.paperId);
    if (!touches || nearTitle === undefined || farTitle === undefined) {
      return [];
    }
    const far =
      collision.a.paperId === input.paperId ? collision.b : collision.a;
    return [
      {
        // Titles in `a`/`b` order, which is the order `collisionLine` prints
        // them in — not near/far order, which is the order a reader thinks in.
        text: collisionLine(collision, NOBODY, nearTitle, farTitle),
        annotationIds: [collision.a.id, collision.b.id],
        pairType: collision.pairType,
        crossPaperIds: [far.id],
      },
    ];
  });
```

and the section becomes:

```ts
    section<A, S>("collisions", [...collisionItems, ...crossItems], cap),
```

- [ ] **Step 4: Give the client a rule it can test.**

Add to `lib/brief/prep.ts`:

```ts
/**
 * Which of a line's citations this page may judge, and what it concludes.
 *
 * The panel re-applies the server's redaction threshold against what *this*
 * reader can currently see, so one check is one place to be wrong. That works
 * because a brief line's citations are on the paper the page has subscribed
 * to — with one exception, which is why this function exists: a cross-paper
 * collision cites a note in another document, the subscription has no row for
 * it, and "no row" would otherwise be read as "withdrawn".
 *
 * So the test runs over the near citations only, and stays all-or-nothing over
 * them: a collision line names both members and quotes each, and there is no
 * version of it with one member removed that is still a true sentence. The far
 * citation is deferred to the server, which re-resolved it against the *lab*
 * rather than the paper (`stillSharedAmong`) — the check that was always the
 * one of record.
 */
export function lineCitations<A extends string>(
  item: { annotationIds: readonly A[]; crossPaperIds?: readonly A[] },
  visible: ReadonlySet<A>,
): { withdrawn: boolean; cited: A[] } {
  const far = new Set<A>(item.crossPaperIds ?? []);
  const withdrawn = item.annotationIds.some(
    (id) => !far.has(id) && !visible.has(id),
  );
  return {
    withdrawn,
    cited: withdrawn
      ? []
      : item.annotationIds.filter((id) => far.has(id) || visible.has(id)),
  };
}
```

- [ ] **Step 5: Store the field and fill the pool.**

In `convex/schema.ts`, the `briefs` sections item shape gains, beside `pairType`:

```ts
      /**
       * Which of this line's citations sit on another paper.
       *
       * Cross-paper collision lines only. Stored rather than re-derived,
       * because the reader that needs it — the presenter's panel — has one
       * paper's margin and no way to ask which document a foreign id belongs
       * to. See `lib/brief/assemble.ts`.
       */
      crossPaperIds: v.optional(v.array(v.id("annotations"))),
```

The identical field goes on `briefItem` in `convex/briefs.ts:92-98` (a shorter comment: "See the schema — the far half of a cross-paper line.").

In `convex/briefs.ts`, beside `POOL_LIMIT`:

```ts
/**
 * How far past this paper one assembly looks, and how much of each neighbour
 * it reads.
 *
 * A brief is built in a mutation that must stay instant — the presenter's
 * button is a transaction, not a job — so the boundary lift is bought with a
 * fixed read budget rather than with "every paper the lab has". Twelve
 * neighbours at 150 rows is 1,800 documents on top of this paper's 1,000: a
 * fifth of the transaction ceiling, for a lab with a reading list longer than
 * anyone's memory of it. Newest papers first, because a cross-paper collision
 * is only interesting while both halves are live reading.
 *
 * The pairing itself is bounded separately and reports when it ran out:
 * `MAX_CROSS_PAPER_COMPARISONS` and `CrossPaperScan.capped`
 * (`lib/digest/engine.ts`).
 */
const CROSS_PAPER_PAPERS = 12;
const CROSS_PAPER_POOL_LIMIT = 150;
```

In `writeBrief`, after `pool` is built and before `assembleBrief`:

```ts
  // The one boundary a brief may see past.
  //
  // `detectCollisions` stops inside a document because a collision is a
  // passage; the second detector (#56, shipped for the digest) crosses on an
  // identical claim of at least sixty characters between two members writing a
  // gold type pair. A session's prep used to have nothing to pair across
  // because its pool was one paper — so this reads the neighbours, and reads
  // them exactly the way the pool above was read: privacy is the index,
  // `by_paper_and_visibility` at "lab", which cannot return a private row.
  const paperTitles = new Map<Id<"papers">, string>([[paper._id, paper.title]]);
  const neighbours = await ctx.db
    .query("papers")
    .withIndex("by_lab", (q) => q.eq("labId", session.labId))
    .order("desc")
    .take(CROSS_PAPER_PAPERS + 1);

  const across: BriefAnnotation<
    Id<"papers">,
    Id<"annotations">,
    Id<"users">,
    Id<"sessions">
  >[] = [];
  for (const other of neighbours) {
    if (other._id === session.paperId) {
      continue;
    }
    const rows = await ctx.db
      .query("annotations")
      .withIndex("by_paper_and_visibility", (q) =>
        q.eq("paperId", other._id).eq("visibility", "lab"),
      )
      .order("desc")
      .take(CROSS_PAPER_POOL_LIMIT);
    const liveRows = rows.filter((a) => a.deletedAt === undefined);
    if (liveRows.length === 0) {
      continue;
    }
    paperTitles.set(other._id, other.title);
    for (const authorId of new Set(liveRows.map((a) => a.memberId))) {
      if (names.has(authorId)) continue;
      const user = await ctx.db.get(authorId);
      names.set(authorId, user?.name ?? user?.email ?? "A lab member");
    }
    for (const a of liveRows) {
      across.push({
        id: a._id,
        paperId: a.paperId,
        memberId: a.memberId,
        memberName: names.get(a.memberId) ?? "A lab member",
        type: a.type,
        pageIndex: a.anchor.pageIndex,
        start: a.anchor.start,
        end: a.anchor.end,
        quote: a.anchor.quote,
        body: a.body,
        createdAt: a._creationTime,
        ...(a.parentId === undefined ? {} : { parentId: a.parentId }),
        ...(a.sessionId === undefined ? {} : { sessionId: a.sessionId }),
      });
    }
  }

  const { sections, citationCount } = assembleBrief({
    pool,
    paperId: session.paperId,
    paperTitle: paper.title,
    priorSessions: await priorSessions(ctx, session),
    // The scan gets both sides; the assembler keeps only pairs that touch this
    // meeting's paper. The neighbours never enter `pool` itself — they are
    // evidence for one section, not material for the other three, and a
    // carried-over question from another paper is a different feature.
    crossPaper: {
      scan: detectCrossPaperCollisions([...pool, ...across]),
      paperTitles,
    },
  });
```

with `detectCrossPaperCollisions` added to the `lib/digest/engine` import at the top of the file.

- [ ] **Step 6: Draw them.**

In `brief.tsx`, import `lineCitations` from `@/lib/brief/prep` (beside `ownPrivateNotes`, `tallyContributors`), then fold it over both places the rule is applied. The numbering registry:

```ts
  const numbering = citationNumbering(
    stored.flatMap((section) =>
      section.items.map((item) => ({
        annotationIds: lineCitations(item, visibleAnnotationIds).cited,
      })),
    ),
  );
```

and `BriefLine`'s opening, replacing lines 538-543:

```ts
  // One rule, two call sites (the registry above folds the same function over
  // the same lines), and it lives in `lib/` because the interesting half is
  // the deferral: a cross-paper citation is not on this page's paper, so this
  // page has no standing to call it withdrawn.
  const { withdrawn, cited } = lineCitations(item, visibleAnnotationIds);
```

The `CitationRef` loop below is unchanged: a far citation has a number and no anchor, so it renders as plain "Note 5" — the same honest shape the file already documents for a citation the board cannot scroll to.

- [ ] **Step 7: Run the tests to verify they pass.**

Run: `npx vitest run lib/brief convex/briefs lib/digest`
Expected: PASS.

- [ ] **Step 8: Full suite + typechecks + lint, then commit.**

```bash
npm test && npx tsc --noEmit && npm run typecheck:convex && npm run lint
git add lib/brief convex/briefs.ts convex/schema.ts convex/delegations.fixtures.ts "app/(app)/app/sessions/[sessionId]/_components/brief.tsx"
git commit -m "$(cat <<'EOF'
C5: the brief remembers the other paper

#56 taught the digest that two members can make the same claim in two
documents; the brief kept stopping at the paper it was about. The scan it
already had now runs over this paper and its twelve most recent neighbours,
and the line names both documents or is not drawn. The far citation is marked
so the panel defers on it — a note the page has no rows for is not a note
somebody withdrew.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The brief's scout section

Design §7, first bullet: the "what is still open from last time" lines gain their finding beneath them, agent-styled, with per-item citations deep-linking to the note; a run still in flight shows a quiet line that resolves reactively; the brief itself never waits. The surface consumes `findings.newestForSubject` and `delegations.listForSubject` and nothing else.

The carried-over section is the only one with subjects: `lib/brief/assemble.ts` builds it from top-level `open-question` notes with no replies, one id per item, and `convex/briefs.ts:317-322` hands exactly those ids to `enqueueForBrief`. Same ids, same section, no second definition.

**Files:**
- Create: `lib/scout/surface.ts`, `lib/scout/surface.test.ts`
- Create: `app/(app)/app/sessions/[sessionId]/_components/scout.tsx`
- Modify: `app/(app)/app/sessions/[sessionId]/_components/brief.tsx` (`BriefSection`, `BriefLine`)

**Interfaces:**
- Produces `lib/scout/surface.ts`: `scoutStatusLine(run)`, `coverageLine(coverage)`, `droppedLine(counts)`, `citationSummary(item, known)`, type `KnownNote`.
- Produces `scout.tsx`: `<ScoutFinding annotationId paperId known />`, `<ScoutStatusChip status />`.
- Consumed by: Task 4 (the outcomes panel renders the same two components against an action subject) and Task 5 (the adopt control hangs off `ScoutFinding`).

- [ ] **Step 1: Write the failing tests.**

`lib/scout/surface.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  citationSummary,
  coverageLine,
  droppedLine,
  scoutStatusLine,
} from "./surface";

/**
 * What a reader is told about a machine's work, and — more to the point — what
 * they are never told. Every sentence here is written by us out of counts and
 * closed vocabularies; none of it is the model's, and none of it says anything
 * about a note that has stopped being shared beyond the fact that a line was
 * here.
 */
describe("scoutStatusLine", () => {
  it("says nothing at all when nobody asked", () => {
    expect(scoutStatusLine(undefined)).toBeNull();
  });

  it("says the scout is looking, while it is", () => {
    expect(scoutStatusLine({ status: "queued" })).toBe("Scout is looking back…");
    expect(scoutStatusLine({ status: "running" })).toBe("Scout is looking back…");
  });

  it("says nothing once it returned — the finding is the answer", () => {
    expect(scoutStatusLine({ status: "returned" })).toBeNull();
  });

  it("calls an empty run a result, not a failure", () => {
    expect(scoutStatusLine({ status: "empty" })).toBe(
      "The scout read the lab's margin and found nothing that bears on this.",
    );
  });

  it("prints the sentence the backend wrote for the failure it had", () => {
    expect(
      scoutStatusLine({
        status: "failed",
        failureReason: "The scout couldn't reach its model.",
      }),
    ).toBe("The scout couldn't reach its model.");
  });

  it("falls back to a sentence of ours when a row carries none", () => {
    expect(scoutStatusLine({ status: "failed" })).toBe(
      "The scout's run didn't finish. Nothing was stored.",
    );
  });

  it("says nothing about a run that was called off", () => {
    // Cancellation is the cascade: the question was settled or withdrawn. The
    // page already shows that, and a second notice about a machine stopping
    // would be the product talking about itself.
    expect(scoutStatusLine({ status: "cancelled" })).toBeNull();
  });
});

describe("coverageLine", () => {
  it("counts what the scout was shown, in the plural it needs", () => {
    expect(
      coverageLine({ annotationsSearched: 24, papersTouched: 3, queriesRun: 1 }),
    ).toBe("Read 24 notes across 3 papers.");
  });

  it("says it in the singular when that is what happened", () => {
    expect(
      coverageLine({ annotationsSearched: 1, papersTouched: 1, queriesRun: 1 }),
    ).toBe("Read 1 note on 1 paper.");
  });
});

describe("droppedLine", () => {
  it("says nothing when nothing was lost", () => {
    expect(droppedLine({ droppedForCitation: 0, redactedCount: 0 })).toBeNull();
  });

  it("counts what the citation gate refused", () => {
    expect(droppedLine({ droppedForCitation: 2, redactedCount: 0 })).toBe(
      "2 lines were dropped because the scout couldn't cite them.",
    );
  });

  it("counts what the margin took back, separately", () => {
    expect(droppedLine({ droppedForCitation: 0, redactedCount: 1 })).toBe(
      "1 line rested on notes that are no longer shared.",
    );
  });

  it("says both when both happened", () => {
    expect(droppedLine({ droppedForCitation: 1, redactedCount: 2 })).toBe(
      "1 line was dropped because the scout couldn't cite it. 2 lines rested on notes that are no longer shared.",
    );
  });
});

describe("citationSummary", () => {
  const known = new Map([
    ["a1", { authorName: "Ana Ruiz", pageIndex: 3 }],
    ["a2", { authorName: "Ben Okafor", pageIndex: 7 }],
  ]);

  it("names the notes this page can resolve", () => {
    expect(citationSummary(["a1", "a2"], known)).toEqual({
      resolved: [
        { id: "a1", authorName: "Ana Ruiz", pageIndex: 3 },
        { id: "a2", authorName: "Ben Okafor", pageIndex: 7 },
      ],
      elsewhere: 0,
    });
  });

  it("counts the ones it cannot, rather than inventing a name for them", () => {
    expect(citationSummary(["a1", "far"], known)).toEqual({
      resolved: [{ id: "a1", authorName: "Ana Ruiz", pageIndex: 3 }],
      elsewhere: 1,
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run lib/scout`
Expected: FAIL — no such module.

- [ ] **Step 3: Write the module.**

`lib/scout/surface.ts`:

```ts
/**
 * What a reader is told about a machine's work.
 *
 * Every sentence in this file is ours. A delegation that failed carries a
 * reason the backend wrote (`FAILURE_SENTENCES`, `convex/delegations.ts`) and
 * this prints it; everything else here is composed out of counts. A model's
 * own words never reach any of these functions, which is why they are pure and
 * why they are tested: a status line is the one place a surface could quietly
 * start narrating.
 *
 * Structural types rather than Convex ones — `lib/` never imports from
 * `convex/`, and these shapes are the ones `delegations.listForSubject` and
 * `findings.newestForSubject` already return.
 */

/** The lifecycle a run walks, exactly as the delegation row records it. */
export type ScoutStatus =
  | "queued"
  | "running"
  | "returned"
  | "empty"
  | "failed"
  | "cancelled";

/** A note this page has a row for, and so can name. */
export type KnownNote = { authorName: string; pageIndex: number };

/**
 * The quiet line under a question while a run is unfinished, or once it ended
 * without a finding. `null` means draw nothing.
 *
 * `returned` draws nothing because the finding underneath *is* the answer, and
 * a status chip over the top of it would be the interface reading itself out
 * loud. `cancelled` draws nothing because the only thing that cancels a run in
 * v1 is the subject being settled or withdrawn — both of which the page has
 * already said, in the place a person was looking.
 */
export function scoutStatusLine(
  run: { status: ScoutStatus; failureReason?: string } | undefined,
): string | null {
  if (run === undefined) return null;
  switch (run.status) {
    case "queued":
    case "running":
      return "Scout is looking back…";
    case "empty":
      return "The scout read the lab's margin and found nothing that bears on this.";
    case "failed":
      // Ours either way: the row's sentence was written by this codebase, and
      // the fallback covers a row that predates the vocabulary.
      return run.failureReason ?? "The scout's run didn't finish. Nothing was stored.";
    case "returned":
    case "cancelled":
      return null;
  }
}

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * How much the scout actually read, from `coverage` — computed in the backend
 * from the material it was shown, never asked of the model (design §13.3).
 *
 * "across" reads wrong for a single paper, and this sentence is the whole
 * evidence a reader has for calibrating a thin finding.
 */
export function coverageLine(coverage: {
  annotationsSearched: number;
  papersTouched: number;
}): string {
  const notes = plural(coverage.annotationsSearched, "note", "notes");
  const papers = plural(coverage.papersTouched, "paper", "papers");
  const where = coverage.papersTouched === 1 ? `on ${papers}` : `across ${papers}`;
  return `Read ${notes} ${where}.`;
}

/**
 * What did not survive, and why — two different facts, never merged.
 *
 * The gate dropped a line because the machine could not cite it; the margin
 * redacted one because a note behind it stopped being shared. A reader
 * calibrating a scout needs the first; a reader calibrating the *record* needs
 * the second, and a single "3 lines missing" would answer neither.
 */
export function droppedLine(counts: {
  droppedForCitation: number;
  redactedCount: number;
}): string | null {
  const parts: string[] = [];
  if (counts.droppedForCitation > 0) {
    const n = counts.droppedForCitation;
    parts.push(
      `${plural(n, "line was", "lines were")} dropped because the scout couldn't cite ${n === 1 ? "it" : "them"}.`,
    );
  }
  if (counts.redactedCount > 0) {
    const n = counts.redactedCount;
    parts.push(
      `${plural(n, "line", "lines")} rested on notes that are no longer shared.`,
    );
  }
  return parts.length === 0 ? null : parts.join(" ");
}

/**
 * An item's citations, split into the ones this page can name and the ones it
 * can only count.
 *
 * The scout searches the lab's whole margin, so most of what a finding cites
 * is on some other paper — and a page that has no row for a note knows its id
 * and nothing else. Naming it anyway would mean inventing an author or a page
 * number; dropping it silently would understate the evidence. It is counted.
 */
export function citationSummary<A extends string>(
  citedAnnotationIds: readonly A[],
  known: ReadonlyMap<A, KnownNote>,
): {
  resolved: { id: A; authorName: string; pageIndex: number }[];
  elsewhere: number;
} {
  const resolved: { id: A; authorName: string; pageIndex: number }[] = [];
  let elsewhere = 0;
  for (const id of citedAnnotationIds) {
    const note = known.get(id);
    if (note === undefined) {
      elsewhere += 1;
      continue;
    }
    resolved.push({ id, ...note });
  }
  return { resolved, elsewhere };
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `npx vitest run lib/scout`
Expected: PASS.

- [ ] **Step 5: Write the component.**

`app/(app)/app/sessions/[sessionId]/_components/scout.tsx`:

```tsx
"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { stripLabels } from "@/lib/citations/labels";
import {
  citationSummary,
  coverageLine,
  droppedLine,
  scoutStatusLine,
  type KnownNote,
} from "@/lib/scout/surface";
import { chipClass } from "@/lib/ui";
import { useQuery } from "convex-helpers/react/cache/hooks";
import Link from "next/link";

/**
 * What a machine found, under the question that provoked it.
 *
 * ## Why this is violet and the brief is not
 *
 * `--secondary` is the second voice, the one the session synthesis is set in,
 * and it means exactly one thing on this page: **a model wrote this**. The
 * brief above is in the lab's own espresso because every line of it is
 * somebody's own writing rearranged. A reader should never have to work out
 * which of the two they are looking at, and colour is the channel that answers
 * before the words do — with the words saying it too, in the eyebrow.
 *
 * ## Nothing here waits for anything
 *
 * The brief renders on its own subscription and this hangs underneath on two
 * more. A question with no run draws nothing at all; a run in flight draws one
 * quiet line that resolves itself when the row moves. There is no path by
 * which a delegation can delay a brief, and there is not meant to be one
 * (design §6.1) — the scout is scheduled strictly after the brief is written,
 * in its own transaction.
 *
 * ## The check this does not repeat
 *
 * `brief.tsx` re-applies the server's redaction rule against the margin it can
 * see, because every brief citation is on this paper. A finding's are not: the
 * gather searches the lab's whole corpus, so "not in my rows" here means
 * "another paper" far more often than it means "withdrawn", and a client
 * running that test would blank the feature. `findings.toView` re-resolves
 * every citation on every read and is documented as the defense of record;
 * this renders what it was handed and counts what it cannot name.
 */
export function ScoutFinding({
  subject,
  paperId,
  known,
}: {
  /** The question the scout was pointed at — an open-question note, or an outcome row. */
  subject:
    | { kind: "annotation"; annotationId: Id<"annotations"> }
    | { kind: "action"; actionId: Id<"actions"> };
  /** The paper whose reader a resolvable citation links into. */
  paperId: Id<"papers">;
  /** The notes this page has rows for, so a citation can be named rather than counted. */
  known: ReadonlyMap<Id<"annotations">, KnownNote>;
}) {
  const runs = useQuery(api.delegations.listForSubject, { subject });
  const finding = useQuery(api.findings.newestForSubject, { subject });

  // Undefined is "the subscription has not landed", and it draws nothing
  // rather than a skeleton: this sits under a line that is already readable,
  // and a shimmering block under every carried-forward question would make a
  // brief look like it was still loading when it was finished.
  if (runs === undefined || runs.length === 0) {
    return null;
  }
  const status = scoutStatusLine(runs[0]);

  if (finding === undefined || finding === null) {
    return status === null ? null : (
      <p
        role="status"
        className="mt-2 font-sans text-xs italic text-ink-faint"
      >
        {status}
      </p>
    );
  }

  const dropped = droppedLine(finding);

  return (
    <div
      style={{ borderLeftColor: "var(--secondary)" }}
      className="mt-3 flex flex-col gap-2 border-l-2 pl-3.5"
    >
      <p className="flex flex-wrap items-baseline gap-x-3">
        <span
          style={{ color: "var(--secondary)" }}
          className="font-sans text-[10px] uppercase tracking-[0.14em]"
        >
          Scout
        </span>
        <span className="font-sans text-[11px] text-ink-faint tabular-nums">
          {coverageLine(finding.coverage)}
        </span>
      </p>

      <ul className="flex flex-col gap-2.5">
        {finding.items.map((item, index) => {
          const { resolved, elsewhere } = citationSummary(
            item.citedAnnotationIds,
            known,
          );
          return (
            <li key={`${finding._id}-${index}`} className="flex flex-col gap-1">
              {/* A redacted item carries the sentence the backend wrote for it
                  and nothing else — no citations drawn as links, no counts, no
                  shape of what was behind it. The ids stay on the wire so a
                  client can reach the same verdict; they are not drawn. */}
              <p
                className={
                  item.redacted
                    ? "max-w-prose font-serif text-[15px] italic leading-relaxed text-ink-faint"
                    : "max-w-prose font-serif text-[15px] leading-relaxed text-ink"
                }
              >
                {item.redacted ? item.text : stripLabels(item.text)}
              </p>
              {!item.redacted && (
                <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-sans text-[11px] text-ink-faint">
                  {resolved.map((note) => (
                    <Link
                      key={note.id}
                      href={`/app/library/${paperId}/read?note=${note.id}`}
                      className="text-accent underline-offset-4 hover:underline tabular-nums"
                    >
                      {note.authorName}, p. {note.pageIndex + 1}
                    </Link>
                  ))}
                  {elsewhere > 0 && (
                    // Counted, not named. The page has no row for these, and a
                    // link it cannot aim is a promise it cannot keep.
                    <span className="tabular-nums">
                      and {elsewhere} more elsewhere in the lab
                    </span>
                  )}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {dropped !== null && (
        <p className="font-sans text-[11px] text-ink-faint tabular-nums">
          {dropped}
        </p>
      )}
    </div>
  );
}

/**
 * A run's state as a mark in the chrome, for a row that has no room for a
 * sentence.
 *
 * `chipClass` is the librarian's pencil note this codebase already uses for a
 * state marker, and it is deliberately not a control: pressing it would do
 * nothing, and there is nothing to filter by.
 */
export function ScoutStatusChip({
  status,
}: {
  status: "queued" | "running" | "returned" | "empty" | "failed" | "cancelled";
}) {
  const word =
    status === "queued" || status === "running"
      ? "scout looking"
      : status === "returned"
        ? "scout returned"
        : status === "empty"
          ? "scout found nothing"
          : null;
  return word === null ? null : (
    <span style={{ color: "var(--secondary)" }} className={chipClass}>
      {word}
    </span>
  );
}
```

- [ ] **Step 6: Hang it under the carried-forward lines.**

In `brief.tsx`, `BriefSection` passes the section's identity down, and the component builds the `known` map once beside the existing memos:

```tsx
  // Author and page for every note this page holds a row for, so a finding's
  // citations can be named instead of counted. Built from the same
  // subscription the board renders — no second query, and nothing in it that
  // the page was not already showing.
  const known = useMemo(
    () =>
      new Map(
        rows
          .filter((row) => row.visibility === "lab" && !row.deleted)
          .map((row) => [
            row._id,
            { authorName: row.authorName, pageIndex: row.anchor.pageIndex },
          ]),
      ),
    [rows],
  );
```

`BriefSection` gains `paperId` and `known` props and forwards them plus `scouted={section.key === "carried-over"}` to `BriefLine`; `BriefLine` renders, immediately after its citation paragraph and inside the non-withdrawn branch:

```tsx
          {/* Only the carried-over lens has subjects: `assembleBrief` builds it
              from unanswered open questions one id at a time, and
              `briefs.writeBrief` hands those same ids to `enqueueForBrief`. One
              definition of "what the scout was pointed at", read twice. */}
          {scouted && firstId !== undefined && (
            <ScoutFinding
              subject={{ kind: "annotation", annotationId: firstId }}
              paperId={paperId}
              known={known}
            />
          )}
```

with `const firstId = item.annotationIds[0];` declared beside `cited`. `paperId` comes from `session.paperId` at the `PresenterBrief` level.

- [ ] **Step 7: Typecheck, lint, and eyeball it.**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: PASS. The browser check is Task 6; the eslint rule that matters here is the `useQuery` import source, which will fail loudly if it came from `convex/react`.

- [ ] **Step 8: Commit.**

```bash
git add lib/scout "app/(app)/app/sessions/[sessionId]/_components/scout.tsx" "app/(app)/app/sessions/[sessionId]/_components/brief.tsx"
git commit -m "$(cat <<'EOF'
C4: what the scout found, under the question that provoked it

The brief's carried-forward lines gain the finding beneath them, in the
second voice, cited by author and page into the reader. A run still in
flight is one quiet line that resolves itself; a question nobody scouted
draws nothing. The brief waits for none of it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Outcomes chips, the finding card, and `findingId` provenance

Design §7 and §13.9: question rows in the outcomes panel show delegation status and the newest finding, and *Settle with this* extends `setSettled` with an optional validated `findingId` — "recording provenance of what informed the settlement. Permissions unchanged."

The schema does **not** already reserve this. `delegations.findingId` (`convex/schema.ts:2087`) is the run's own result and `delegation.returned` carries one (`:950`); nothing on `actions` or on `action.settled` records what a human settled *with*. This adds both, and they are the only writes in the whole PR.

**Files:**
- Modify: `convex/schema.ts` (`actions` table :1594-1642, the `action.settled` event :884-891)
- Modify: `convex/actions.ts` (`outcomeView` :111-136, `toView` :648-694, `setSettled` :438-490)
- Modify: `app/(app)/app/sessions/[sessionId]/_components/outcomes.tsx` (`OutcomeBody`, `OutcomeControls`)
- Create: `convex/actions.test.ts`

**Interfaces:**
- Produces: `actions.setSettled({ actionId, settled, findingId? })`; `outcomeView.settledWithFindingId?: Id<"findings">`.
- Consumed by: the outcomes panel, and nothing else in this PR.

- [ ] **Step 1: Write the failing tests.**

`convex/actions.test.ts`:

```ts
import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import { setSettled } from "./actions";
import { FakeCtx, handlerOf, rowAt, seedLab } from "./delegations.fixtures";

vi.mock("@convex-dev/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/auth/server")>()),
  getAuthUserId: async (ctx: unknown) =>
    (ctx as { auth?: { userId?: string } }).auth?.userId ?? null,
}));

/**
 * Settling a question with a machine's report in front of you.
 *
 * The claim being stored is provenance — "this is what informed it" — and
 * provenance nobody checked is decoration. So the id is validated against the
 * question it names, not merely against the lab: a report about somebody
 * else's question is not evidence about this one, whoever pasted the id.
 */
async function seedFinding(
  ctx: FakeCtx,
  seed: Awaited<ReturnType<typeof seedLab>>,
  actionId: Id<"actions">,
): Promise<Id<"findings">> {
  const delegationId = await ctx.db.insert("delegations", {
    labId: seed.labId,
    agentKind: "scout.corpus",
    trigger: "manual",
    actionId,
    requestedBy: seed.pi,
    requestedAt: 1,
    status: "returned",
  });
  return await ctx.db.insert("findings", {
    labId: seed.labId,
    delegationId,
    agentKind: "scout.corpus",
    actionId,
    items: [
      {
        text: "Two members read the 4°C step the same way.",
        citedAnnotationIds: [seed.questionId],
        citedPaperIds: [seed.paperId],
      },
    ],
    coverage: { annotationsSearched: 4, papersTouched: 1, queriesRun: 1 },
    droppedForCitation: 0,
    model: "test",
    generatedAt: 1,
  });
}

describe("settling with a finding", () => {
  it("records which report informed it", async () => {
    const ctx = new FakeCtx();
    const seed = await seedLab(ctx);
    const findingId = await seedFinding(ctx, seed, seed.actionId);
    ctx.auth = { userId: seed.pi };

    await handlerOf(setSettled)(ctx, {
      actionId: seed.actionId,
      settled: true,
      findingId,
    });

    const action = await ctx.db.get(seed.actionId);
    expect(action?.settledWithFindingId).toBe(findingId);
    const event = rowAt(
      (await ctx.db.query("events").collect()).filter(
        (row) => row.type === "action.settled",
      ),
    );
    expect(event.findingId).toBe(findingId);
  });

  it("settles without one, exactly as it always did", async () => {
    const ctx = new FakeCtx();
    const seed = await seedLab(ctx);
    ctx.auth = { userId: seed.pi };

    await handlerOf(setSettled)(ctx, { actionId: seed.actionId, settled: true });

    const action = await ctx.db.get(seed.actionId);
    expect(action?.settledAt).toBeGreaterThan(0);
    expect(action?.settledWithFindingId).toBeUndefined();
  });

  it("refuses a finding about a different question", async () => {
    const ctx = new FakeCtx();
    const seed = await seedLab(ctx);
    const other = await ctx.db.insert("actions", {
      labId: seed.labId,
      sessionId: seed.sessionId,
      paperId: seed.paperId,
      kind: "question",
      body: "Something else entirely?",
      recordedBy: seed.pi,
    });
    const findingId = await seedFinding(ctx, seed, other);
    ctx.auth = { userId: seed.pi };

    await expect(
      handlerOf(setSettled)(ctx, {
        actionId: seed.actionId,
        settled: true,
        findingId,
      }),
    ).rejects.toThrow(ConvexError);
    expect((await ctx.db.get(seed.actionId))?.settledAt).toBeUndefined();
  });

  it("lets go of the provenance when the question is reopened", async () => {
    const ctx = new FakeCtx();
    const seed = await seedLab(ctx);
    const findingId = await seedFinding(ctx, seed, seed.actionId);
    ctx.auth = { userId: seed.pi };

    await handlerOf(setSettled)(ctx, {
      actionId: seed.actionId,
      settled: true,
      findingId,
    });
    await handlerOf(setSettled)(ctx, { actionId: seed.actionId, settled: false });

    const action = await ctx.db.get(seed.actionId);
    // The answer did not hold, so what informed it is not a fact about the row
    // any more. The ledger still has both events, which is where a walk
    // between states belongs.
    expect(action?.settledWithFindingId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run convex/actions`
Expected: FAIL — `findingId` is not an accepted argument.

- [ ] **Step 3: Widen the schema.**

In `convex/schema.ts`, on the `actions` table after `settledBy`:

```ts
    /**
     * The scout's report a human had in front of them when they settled it.
     *
     * Provenance, not authority: a machine still settles nothing (§3.2), and
     * this field changes no permission and no outcome. What it buys is the
     * question a lab asks itself six months later — *why did we decide that* —
     * having an answer that survives the reasoning being forgotten.
     *
     * Cleared on reopen. A question that came back open is not a question that
     * was settled with a report; the ledger keeps both events, which is where
     * a walk between states is supposed to live.
     */
    settledWithFindingId: v.optional(v.id("findings")),
```

and on the `action.settled` event, after `kind`:

```ts
    /**
     * What informed it, when a scout's report did. An id and nothing else —
     * the ledger carries no prose, least of all a machine's paraphrase of
     * notes whose authors can un-share them tomorrow.
     */
    findingId: v.optional(v.id("findings")),
```

- [ ] **Step 4: Validate it and write it.**

In `convex/actions.ts`, add above `setSettled`:

```ts
/**
 * The finding a settlement may name, or nothing.
 *
 * Validated rather than trusted, because a `findingId` arrives from a browser
 * and "this is what we settled on" is exactly the kind of claim a record is
 * worthless without. Two checks and no more: the report is this lab's, and it
 * is about *this* question. A report about a different question is not weaker
 * evidence about this one — it is not evidence about it at all.
 *
 * Refused loudly rather than dropped quietly. Settling is one press, and a
 * press that silently recorded less than it said it would is worse than one
 * that failed.
 */
async function settlementFinding(
  ctx: MutationCtx,
  action: Doc<"actions">,
  findingId: Id<"findings"> | undefined,
): Promise<Id<"findings"> | undefined> {
  if (findingId === undefined) {
    return undefined;
  }
  const finding = await ctx.db.get(findingId);
  if (
    finding === null ||
    finding.labId !== action.labId ||
    finding.actionId !== action._id
  ) {
    throw new ConvexError(
      "That report isn't about this question, so it can't be what settled it.",
    );
  }
  return finding._id;
}
```

`setSettled`'s args gain `findingId: v.optional(v.id("findings"))` with a one-line comment pointing at §7, and the settling branch becomes:

```ts
    if (args.settled) {
      // Before the patch: a settlement that recorded the wrong provenance is
      // worse than one that refused, and the check is a read either way.
      const informedBy = await settlementFinding(ctx, action, args.findingId);
      await ctx.db.patch(action._id, {
        settledAt: Date.now(),
        settledBy: userId,
        ...(informedBy === undefined ? {} : { settledWithFindingId: informedBy }),
      });
      ...unchanged cascade comment and call...
    } else {
      await ctx.db.patch(action._id, {
        settledAt: undefined,
        settledBy: undefined,
        settledWithFindingId: undefined,
      });
    }
```

`informedBy` has to be in scope at the `recordEvent` below, so hoist it:
`let informedBy: Id<"findings"> | undefined;` before the branch, assigned inside. The event gains `...(informedBy === undefined ? {} : { findingId: informedBy })`.

`outcomeView` gains `settledWithFindingId: v.optional(v.id("findings"))` (comment: "What informed it, for the panel to say so.") and `toView` returns `settledWithFindingId: action.settledWithFindingId`.

- [ ] **Step 5: Run to verify it passes.**

Run: `npx vitest run convex/actions convex/sessions`
Expected: PASS.

- [ ] **Step 6: Draw the chip, the card, and the control.**

In `outcomes.tsx`:

`OutcomeCard` and `CarriedForward`'s `<li>` render, for question rows only, the run's chip beside the recorder line and the finding beneath the body:

```tsx
  const subject = { kind: "action", actionId: outcome._id } as const;
```

- in `OutcomeBody`, after the `settled` paragraph:

```tsx
      {outcome.settledWithFindingId !== undefined && (
        // Provenance, said where the settlement is said. Not a link: the
        // report is drawn on this same row, right below.
        <p className="font-sans text-[11px] text-ink-faint">
          Settled with the scout&rsquo;s report.
        </p>
      )}
```

- in `OutcomeCard`, after `<OutcomeBody />` and before `<OutcomeControls />`, for `outcome.kind === "question"` only:

```tsx
      {outcome.kind === "question" && (
        <ScoutFinding subject={subject} paperId={paperId} known={known} />
      )}
```

`paperId` and `known` thread down from `SessionOutcomes` exactly as in Task 3 (`session.paperId`, and the same `useMemo` over `rows`). Chips come from `useQuery(api.delegations.listForSubject, { subject })` inside a small `ScoutChip` wrapper in `scout.tsx`:

```tsx
/** The row's newest run, as a chip. Subscribes so a card in flight settles itself. */
export function ScoutChip({ subject }: { subject: Parameters<typeof ScoutFinding>[0]["subject"] }) {
  const runs = useQuery(api.delegations.listForSubject, { subject });
  const newest = runs?.[0];
  return newest === undefined ? null : <ScoutStatusChip status={newest.status} />;
}
```

rendered in the `OutcomeBody` attribution line for question rows.

`OutcomeControls` gains the settle-with-finding path. The existing "Mark it answered" button stays exactly as it is — permissions unchanged, and a settlement with no report is the ordinary case:

```tsx
  const finding = useQuery(
    api.findings.newestForSubject,
    outcome.kind === "question" && outcome.canSettle && !settled
      ? { subject: { kind: "action", actionId: outcome._id } }
      : "skip",
  );
```

and, beside the existing button:

```tsx
        {outcome.canSettle && !settled && finding !== undefined && finding !== null && (
          // A second door to the same mutation, and the only difference is what
          // it records. The permission is `canSettle` in both — a report does
          // not widen who may close a question, and it was never meant to
          // (design §8: "Settle (with or without finding) — unchanged").
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              void run(
                () =>
                  setSettled({
                    actionId: outcome._id,
                    settled: true,
                    findingId: finding._id,
                  }),
                "That didn't take.",
              )
            }
            className={`${linkButtonClass} text-xs tap-target`}
          >
            Settle with this
          </button>
        )}
```

with `linkButtonClass` added to the `@/lib/ui` import.

- [ ] **Step 7: Typecheck, lint, full suite, commit.**

```bash
npm test && npx tsc --noEmit && npm run typecheck:convex && npm run lint
git add convex/schema.ts convex/actions.ts convex/actions.test.ts "app/(app)/app/sessions/[sessionId]/_components/outcomes.tsx" "app/(app)/app/sessions/[sessionId]/_components/scout.tsx"
git commit -m "$(cat <<'EOF'
C4: settling a question says what it was settled with

`setSettled` takes an optional finding, validated against the question it
names — a report about somebody else's is refused rather than recorded. The
field is provenance and nothing else: no permission moves, no machine settles
anything, and reopening lets go of it because the answer did not hold.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Adopt citations — the composer, prefilled with pointers and nothing else

Design §7 and §13.9: *Adopt citations* prefills a composer with **citation links only, never model prose** — "prefilled prose is machine speech laundered into the human-speech table". The member writes their own words.

An annotation's thread lives in the reader, so the control is a deep link on the existing `?note=` convention (`reader.tsx:917-975`, already used by notifications and the temporal panel) with one more parameter. The seed is built from the cited notes' own passages, never from the finding's text.

**Files:**
- Create: `lib/scout/adopt.ts`, `lib/scout/adopt.test.ts`
- Modify: `app/(app)/app/sessions/[sessionId]/_components/scout.tsx` (the adopt control)
- Modify: `app/(app)/app/library/[paperId]/read/_components/reader.tsx` (the `adopt` parameter and the seed)
- Modify: `app/(app)/app/library/[paperId]/read/_components/margin-rail.tsx` (one prop, two call sites)
- Modify: `app/(app)/app/library/[paperId]/read/_components/annotation-card.tsx` (`seedReply`)

**Interfaces:**
- Produces `lib/scout/adopt.ts`: `adoptSeed(citations: readonly AdoptCitation[]): string`, type `AdoptCitation = { authorName: string; pageIndex: number; quote: string }`.
- Produces: `<MarginRail seedReply?={{ annotationId, body }} />`, `<AnnotationCard seedReply?: string />`.

- [ ] **Step 1: Write the failing test.**

`lib/scout/adopt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { adoptSeed } from "./adopt";

/**
 * The one rule: what a member's composer opens with must be pointers, not
 * prose. A finding's sentences were written by a model, and a reply table that
 * accepted them — even as a starting draft somebody then edited — would be
 * machine speech laundered into the one table this product promises is human.
 */
describe("adoptSeed", () => {
  it("carries the passages, whose page and author a reader can check", () => {
    expect(
      adoptSeed([
        { authorName: "Ana Ruiz", pageIndex: 3, quote: "incubated at 4°C overnight" },
        { authorName: "Ben Okafor", pageIndex: 7, quote: "two independent cohorts" },
      ]),
    ).toBe(
      "\n\nAna Ruiz, p. 4: “incubated at 4°C overnight”\n" +
        "Ben Okafor, p. 8: “two independent cohorts”",
    );
  });

  it("opens above the pointers, so the member types first", () => {
    expect(adoptSeed([{ authorName: "Ana Ruiz", pageIndex: 0, quote: "x" }])).toMatch(
      /^\n\n/,
    );
  });

  it("elides a passage long enough to become the reply", () => {
    const long = "a".repeat(200);
    const seeded = adoptSeed([{ authorName: "Ana Ruiz", pageIndex: 0, quote: long }]);
    expect(seeded).toContain("…");
    expect(seeded.length).toBeLessThan(160);
  });

  it("is empty when there is nothing to point at", () => {
    expect(adoptSeed([])).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run lib/scout/adopt`
Expected: FAIL — no such module.

- [ ] **Step 3: Write it.**

`lib/scout/adopt.ts`:

```ts
import { cleanQuote } from "../quotes";

/** One note a member is pointing at: who wrote on it, where, and what it marked. */
export type AdoptCitation = {
  authorName: string;
  pageIndex: number;
  quote: string;
};

/** Enough of a passage to recognise, short enough that it cannot become the reply. */
const MAX_QUOTE = 90;

/**
 * What a composer opens with when a member adopts a finding's citations.
 *
 * Pointers and nothing else. The finding's own sentences are a model's
 * paraphrase, and `annotations` is the human-speech table (design §3.1) — a
 * prefilled draft of machine prose is that rule broken with an extra step,
 * because what lands in the table afterwards has a person's name on it.
 *
 * What is carried is the *paper's* words: an author, a page, and the passage
 * each note marked. Not the notes' bodies — a reply that opens by quoting
 * three colleagues back at themselves is not a citation, it is a summary
 * somebody else wrote, and this composer is for the member's own answer.
 *
 * The blank lines come first so the cursor's natural home is above the
 * pointers, which is where the answer goes.
 */
export function adoptSeed(citations: readonly AdoptCitation[]): string {
  if (citations.length === 0) {
    return "";
  }
  const lines = citations.map(
    (one) =>
      `${one.authorName}, p. ${one.pageIndex + 1}: “${cleanQuote(one.quote, MAX_QUOTE)}”`,
  );
  return `\n\n${lines.join("\n")}`;
}
```

(`cleanQuote` is `lib/quotes.ts`, already used by the brief and the outcomes panel for exactly this.)

- [ ] **Step 4: Run to verify it passes.**

Run: `npx vitest run lib/scout`
Expected: PASS.

- [ ] **Step 5: The control.**

In `scout.tsx`, under the item list, for annotation subjects only:

```tsx
      {subject.kind === "annotation" && (
        // Into the reader, at the question, with the composer open on its
        // citations. Action rows get no adopt (design §7): there is no thread
        // under an outcome to reply into, and inventing one would be a second
        // place the lab argues about the same question.
        <Link
          href={`/app/library/${paperId}/read?note=${subject.annotationId}&adopt=1`}
          className={`${linkButtonClass} self-start text-xs`}
        >
          Adopt citations
        </Link>
      )}
```

- [ ] **Step 6: The reader end.**

In `reader.tsx`, beside the existing `requestedNote` state:

```ts
  /**
   * Somebody arrived here from a finding, to answer the question themselves.
   *
   * Read from the URL in the same effect and spent in the same cleanup as
   * `?note=`, because they are one gesture: a pointer at a note, and a request
   * to open its composer on the citations behind a scout's report of it. The
   * finding is fetched here rather than carried in the link — a URL is a place
   * a person can paste anything, and the composer's contents are decided by
   * what the server will still serve, not by what a query string said.
   */
  const [adoptFor, setAdoptFor] = useState<string | null>(null);
```

set inside the existing `useEffect` that reads `window.location`, from `searchParams.get("adopt") === "1" ? searchParams.get("note") : null`, and `url.searchParams.delete("adopt")` in the existing cleanup.

Then:

```ts
  const adoptFinding = useQuery(
    api.findings.newestForSubject,
    adoptFor === null
      ? "skip"
      : {
          subject: {
            kind: "annotation",
            annotationId: adoptFor as Id<"annotations">,
          },
        },
  );

  const seedReply = useMemo(() => {
    if (adoptFor === null || adoptFinding === undefined || adoptFinding === null) {
      return undefined;
    }
    const byId = new Map(rows.map((row) => [row._id, row]));
    // Only the items still standing. A redacted item's citations are the ones
    // that moved; carrying them into somebody's draft would put a withdrawn
    // note's passage back on a screen through a side door.
    const cited = new Set(
      adoptFinding.items
        .filter((item) => !item.redacted)
        .flatMap((item) => item.citedAnnotationIds),
    );
    const body = adoptSeed(
      [...cited].flatMap((id) => {
        const row = byId.get(id);
        return row === undefined || row.deleted
          ? []
          : [
              {
                authorName: row.authorName,
                pageIndex: row.anchor.pageIndex,
                quote: row.anchor.quote,
              },
            ];
      }),
    );
    return body.length === 0
      ? undefined
      : { annotationId: adoptFor as Id<"annotations">, body };
  }, [adoptFor, adoptFinding, rows]);
```

passed to `<MarginRail seedReply={seedReply} />`.

`margin-rail.tsx` takes `seedReply?: { annotationId: AnnotationId; body: string }` and forwards `seedReply={seedReply?.annotationId === entry.annotation._id ? seedReply.body : undefined}` at both `<AnnotationCard>` call sites (`:300`, `:473`).

`annotation-card.tsx` takes `seedReply?: string` and, beside its existing state:

```tsx
  // Somebody arrived here to answer this, with the notes a scout cited already
  // in front of them. The composer opens once, on the pointers and none of the
  // machine's prose (`lib/scout/adopt.ts`); everything typed after this is
  // theirs.
  useEffect(() => {
    if (seedReply === undefined) return;
    setReplying(true);
    setReplyBody((current) => (current.length === 0 ? seedReply : current));
  }, [seedReply]);
```

- [ ] **Step 7: Typecheck, lint, full suite, commit.**

```bash
npm test && npx tsc --noEmit && npm run lint
git add lib/scout "app/(app)/app/sessions/[sessionId]/_components/scout.tsx" "app/(app)/app/library/[paperId]/read/_components"
git commit -m "$(cat <<'EOF'
C4: adopting a finding's citations, and none of its sentences

The control lands in the reader at the question with the composer open on
the passages behind the report — author, page, quote, and a blank line above
them for the member's own answer. The model's prose does not travel: a
prefilled paraphrase in the annotations table is machine speech with a
person's name on it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The browser pass, and the documents

The dev deployment (`festive-boar-562`) now holds a real end-to-end corpus: a **returned** finding with three cited items on the "S6 boundary-crossing" session's lab, plus an `empty` delegation and a `failed` one carrying `model-unavailable`. That is every state this PR draws except `queued`/`running`, which the pass produces by hand.

**Files:**
- Modify: `docs/TIMELINE.md` (C4 and C5 boxes)
- Modify: `docs/design/agent-delegation.md` (§7, §12)

- [ ] **Step 1: Run the app against dev.**

```bash
npx convex dev --once
npm run dev
```

- [ ] **Step 2: Walk the brief.** Open the "S6 boundary-crossing" session as the presenter.

1. The brief renders immediately, before any finding does. Reload with the network throttled and confirm the agenda is readable while the scout section is still blank — the brief must never wait.
2. Under a carried-forward question with the returned finding: the block is violet-ruled, headed **Scout**, and reads "Read N notes across M papers." Every item's prose contains **no `[A` marker**. Citations name an author and a page and link into the reader; anything the page cannot resolve is counted, never named.
3. The question with the `empty` delegation shows one quiet italic line and no card. The `failed` one shows the `model-unavailable` sentence from `FAILURE_SENTENCES` — *"The scout couldn't reach its model…"* — and nothing about an API key.
4. Take one cited note private in another tab (the reader's visibility control). The item's text becomes the redaction sentence within a second, its citations disappear from the line, and the "lines rested on notes that are no longer shared" count appears. Nothing of the original sentence survives on screen.

- [ ] **Step 3: Watch a run in flight.** From the terminal:

```bash
npx convex run delegations:enqueueForBrief '{"briefId":"<brief id>","annotationIds":["<carried question id>"]}'
```

The line under that question must show "Scout is looking back…" without a reload and resolve itself when the row moves. Confirm in the dashboard that the brief row was not touched.

- [ ] **Step 4: Walk the outcomes panel.** On the same session, on a `question` outcome: settle it and confirm the ordinary path is unchanged — no report exists for an action subject in v1, so no *Settle with this* is offered and nothing about the row looks different from before this PR.

To see the control at all, seed an action-subject run by hand in the Convex dashboard's data tab on `festive-boar-562`: one `delegations` row (`agentKind: "scout.corpus"`, `trigger: "manual"`, `actionId` = the question outcome, `status: "returned"`) and one `findings` row with the same `labId`, `actionId` and `delegationId`, one item citing a real annotation on that lab. Then confirm the chip reads "scout returned", the card draws under the outcome body, *Settle with this* settles the row, and the card afterwards reads "Settled with the scout's report." Reopen it and confirm that line goes. Delete both rows when the pass is done — dev is a demo corpus, not a fixture.

- [ ] **Step 5: Walk adopt.** Press *Adopt citations* under a finding in the brief. The reader opens at the question, scrolled to its passage, with the reply composer open and containing only author/page/quote lines and a blank line above them. Type an answer, send it, and confirm the reply lands under the question and the brief's carried-over section drops it on the next assembly (a question with a reply is no longer carried).

- [ ] **Step 6: Walk C5.** On a lab with two papers sharing a long identical passage (the dev corpus has one; otherwise annotate the same sentence in two papers as two different members with a gold pair of types), assemble a brief and confirm the collisions section carries a line naming **both** documents, ranked below every same-paper line, with its citations rendered as plain "Note N" rather than held back as withdrawn.

- [ ] **Step 7: Keyboard and reduced motion.** Tab to *Settle with this* and *Adopt citations*: both take focus visibly, both fire on Enter and Space, neither moves layout under the finger. With `prefers-reduced-motion: reduce`, the press keeps its colour change and loses the give.

- [ ] **Step 8: Correct the documents.**

In `docs/TIMELINE.md`, tick C4 and C5 with one paragraph naming what landed: the marker grammar close, the brief section, the panel's chips and card, `findingId` provenance, citations-only adopt, and the cross-paper lift — and that **the launch gate stays shut**: C2 has still not shown the scout beating the search drawer, so none of this goes to design partners yet.

In `docs/design/agent-delegation.md`: §7's empty/failed sentence is corrected to say the reader's sentence comes from the failure vocabulary (`coverage` exists only on a returned finding), and §12's PR D line is marked shipped with the note that C5 rode along.

- [ ] **Step 9: Full suite, typechecks, lint, commit.**

```bash
npm test && npx tsc --noEmit && npm run typecheck:convex && npm run lint
git add docs/TIMELINE.md docs/design/agent-delegation.md
git commit -m "$(cat <<'EOF'
Docs: C4 and C5 are shipped boxes, and the gate is still shut

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Flagged, not done (put these in the PR body)

- **`lib/actions/outcomes.ts:33` still names the paper boundary as Phase 2's.** Carry-forward of *outcomes* is per-paper and stays that way in this PR — C5 lifted the boundary for collisions only, which is what the timeline scoped.
- **A cross-paper citation renders as a plain "Note N".** It could link into the far paper's reader; that needs the far `paperId` on the stored item and a second field is not worth it until somebody asks for the link.
- **`brief.tsx` renders the far half of a collision without a status.** Epistemic status is read from `rows`, which is this paper's margin; a far note's status is simply not on this page. Design §7's "statuses rendered mechanically next to citations" is honoured for everything the page can resolve.
- **Inline markers are stripped, not resolved.** A model using a label as a noun leaves an awkward sentence. Storing the run's label→id map on the finding would let a surface render "Note 3" properly; that is a schema change and a separate argument.
- **The outcomes panel's scout affordances are empty until v1.5.** No action-subject delegation exists in v1 by design. The components are shared with the brief, so they are exercised, but the panel's own path is only covered by `convex/actions.test.ts` and a hand-seeded row.
- **`writeBrief` now reads up to 1,800 more documents.** Well inside the transaction ceiling, and the caps are named — but it is the first time assembling a brief costs more than one paper's margin, and it is the number to watch if a lab's reading list grows past a hundred papers.
- **Two OpenAI call sites, `MAX_SEARCH_LENGTH` defined twice, and the `sessions ↔ synthesis` import cycle** all survive from C3's backlog, untouched.
- **The launch gate stays shut.** C2 reports n=0 scoreable questions on dev; §10.2 needs a corpus with settled, cited questions before any of this reaches design partners.
