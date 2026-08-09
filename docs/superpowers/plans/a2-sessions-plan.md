# A2 — Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the session surface honest and legible: the Start button tells the truth about the window, End/Cancel confirm and can be undone, board quotes read like sentences, the type spine is readable, synthesis citations carry stable document-wide numbers that link to real anchors, and the reader's way back to the session looks like one.

**Architecture:** Pure rules go to `lib/` with vitest coverage (start-window predicate, quote cleaner, citation numbering); Convex gains two guarded back-edge mutations (`reopenSession`, `restoreSession`) that append compensating ledger events; UI edits stay inside the existing class/press/toast vocabulary. Ground truth for every line number and current behavior: `.superpowers/sdd/a2-sessions-plan/audit.md` — the audit is accurate as of branch cut and each task below restates what it needs from it.

**Tech Stack:** Next.js App Router, Convex, Base UI, Tailwind semantic tokens, vitest (node env — no DOM harness; browser-only behavior is verified in a manual pass at the end).

## Global Constraints

- `useQuery` from `convex-helpers/react/cache/hooks`, never `convex/react` (eslint-enforced); `useMutation`/`useAction` from `convex/react`.
- All UI classes from `lib/ui.ts` vocabulary; buttons carry `pressable`; colour via semantic tokens only; chrome sans, content serif.
- Toast API is push-only: `useToast()` → `toast({ message, tone?, action?: { label, onAction }, durationMs? })`. Undo renders from `action`.
- Confirm primitive is `ConfirmAction`; `confirmLabel` restates the act, never "Confirm".
- Server decides permissions; client receives booleans (`canManage` etc.) and never re-derives them.
- Human-readable refusals are `ConvexError`; client renders via `readableError` in `<p role="alert" aria-live="polite" className={errorClass}>`.
- Ledger rows are claims about what happened: an undo APPENDS a compensating event; nothing is ever deleted or rewritten.
- The start window stays one-sided: >24h early is refused, late is always allowed (documented decision, `convex/sessions.ts:663–671`). No task may add a lateness gate.
- The spine keeps its live `flex-grow` transition, ontology order, and only-present-types behavior.
- `?session=` on the reader URL drives the privacy default and must survive every link rework.
- Privacy filtering happens once in `groupSessionNotes`, never per component; nothing keyed by member.
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

**Plan-vs-code conflict, resolved here so no task re-litigates it:** `manage.tsx:29–40` documents "only cancelling arms first". The timeline directive ("End/Cancel confirm + undo toast") governs; Task 4 overturns the comment and rewrites it to state the new rule.

---

### Task 1: Start-window predicate in lib + server copy fix

**Files:**
- Create: `lib/session-window.ts`
- Test: `lib/session-window.test.ts`
- Modify: `convex/sessions.ts` (constant import at ~:52, message + `untilProse` at ~:356–362 and ~:689–694)

**Interfaces:**
- Produces: `MAX_EARLY_START_MS` (24h in ms), `startWindow(scheduledAt: number, now: number): { canStart: boolean; msUntilOpen: number }`, `awayProse(ms: number): string` ("about 25 hours away" / "about 3 days away"). Task 2 consumes `startWindow` + `awayProse`; `convex/sessions.ts` consumes all three.

- [ ] **Step 1: Write the failing test**

```ts
// lib/session-window.test.ts
import { describe, expect, it } from "vitest";
import { MAX_EARLY_START_MS, awayProse, startWindow } from "./session-window";

const HOUR = 3_600_000;

describe("startWindow", () => {
  it("opens exactly at the 24h boundary", () => {
    const now = 1_000_000_000_000;
    expect(startWindow(now + MAX_EARLY_START_MS, now).canStart).toBe(true);
    expect(startWindow(now + MAX_EARLY_START_MS + 1, now).canStart).toBe(false);
  });
  it("is one-sided: late is always startable", () => {
    const now = 1_000_000_000_000;
    expect(startWindow(now - 90 * 24 * HOUR, now).canStart).toBe(true);
  });
  it("reports how long until the window opens", () => {
    const now = 1_000_000_000_000;
    const { msUntilOpen } = startWindow(now + 25 * HOUR, now);
    expect(msUntilOpen).toBe(HOUR);
  });
});

describe("awayProse", () => {
  it("speaks hours under two days", () => {
    expect(awayProse(25 * HOUR)).toBe("about 25 hours away");
  });
  it("speaks days from two days up", () => {
    expect(awayProse(72 * HOUR)).toBe("about 3 days away");
  });
});
```

- [ ] **Step 2: Run it** — `npx vitest run lib/session-window.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// lib/session-window.ts
/**
 * When a scheduled session may be started, shared by the button that offers
 * it and the mutation that enforces it. One-sided on purpose: labs run late
 * all the time and a session started after its hour is still that session,
 * so only absurdly-early (more than a day) is refused.
 */
export const MAX_EARLY_START_MS = 24 * 60 * 60 * 1000;

export function startWindow(scheduledAt: number, now: number) {
  const early = scheduledAt - now;
  return {
    canStart: early <= MAX_EARLY_START_MS,
    msUntilOpen: Math.max(0, early - MAX_EARLY_START_MS),
  };
}

/** "about 25 hours away" — a distance, readable after "is still". */
export function awayProse(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  return hours < 48
    ? `about ${hours} hours away`
    : `about ${Math.round(hours / 24)} days away`;
}
```

- [ ] **Step 4: Wire the server.** In `convex/sessions.ts`: delete the local `MAX_EARLY_START_MS` (~:52, keep its doc comment beside the import) and `untilProse` (~:356–362, it has no other caller — verify with grep first); import both from `lib/session-window`; rewrite the refusal (~:689–694) using the predicate so client and server share one rule:

```ts
const { canStart } = startWindow(session.scheduledAt, Date.now());
if (!canStart) {
  throw new ConvexError(
    `That session is still ${awayProse(session.scheduledAt - Date.now())}. Start it closer to the time, or reschedule it if the meeting really has moved.`,
  );
}
```

This kills the doubled-preposition sentence ("isn't until in about 25 hours").

- [ ] **Step 5: Run the whole suite + typecheck** — `npx vitest run && npx tsc --noEmit` — PASS.
- [ ] **Step 6: Commit.**

---

### Task 2: Start button disabled outside the window, with an inline hint

**Files:**
- Modify: `app/(app)/app/sessions/[sessionId]/_components/manage.tsx` (Start button at ~:74–88)

**Interfaces:**
- Consumes: `startWindow`, `awayProse`, `MAX_EARLY_START_MS` from `lib/session-window` (Task 1); `SessionDetail` already carries `scheduledAt`.

- [ ] **Step 1: Add a ticking `now`.** In `ManageSession`, `const [now, setNow] = useState(() => Date.now());` plus an effect that re-arms `setInterval(() => setNow(Date.now()), 30_000)` only while `session.status === "scheduled"` and `!startWindow(session.scheduledAt, now).canStart` (clear on unmount and when the window opens — no interval left running on a live session). 30s granularity is fine for a 24h window.

- [ ] **Step 2: Gate the button and add the hint.** Where `status === "scheduled"` renders Start:

```tsx
{session.status === "scheduled" && (() => {
  const window = startWindow(session.scheduledAt, now);
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        disabled={pending || !window.canStart}
        className={primaryButtonClass}
        onClick={() =>
          void run(
            () => startSession({ sessionId: session._id }),
            "That session didn't start.",
          )
        }
      >
        {pending ? "Starting…" : "Start session"}
      </button>
      {!window.canStart && (
        <p className="font-sans text-xs text-ink-faint">
          Still {awayProse(session.scheduledAt - now)} — you can start it up to
          a day early, or reschedule it if the meeting moved.
        </p>
      )}
    </div>
  );
})()}
```

The hint appears only while the button is disabled: an enabled button explaining itself is noise. Late sessions render no hint and no gate (one-sided window, Global Constraints). Keep the server check untouched — the button gating is a courtesy, the mutation stays the law.

- [ ] **Step 3: Suite + typecheck + lint pass.** No new unit test possible (no DOM harness) — the window predicate itself is covered by Task 1; note the manual-pass item: "session >24h out shows disabled Start + hint; hint absent within window and for past sessions."
- [ ] **Step 4: Commit.**

---

### Task 3: Back-edge mutations — `reopenSession` and `restoreSession`

**Files:**
- Modify: `convex/sessions.ts`
- Test: `convex/sessions.test.ts` (new — this file has zero tests today; test only what this task adds plus the start-window refusal, not the whole lifecycle)

**Interfaces:**
- Produces: `reopenSession({ sessionId })` — `ended → live`; `restoreSession({ sessionId })` — `cancelled → scheduled`. Both: `requireManage`; refused with a `ConvexError` when the session is not in the expected status (reuse `refuse()`/`STATUS_PROSE` idiom at ~:281–285) or when the undo window has lapsed. Task 4 consumes both.

**Design (settled here):**
- **Undo window:** 10 minutes, measured from the forward move. Both `endSession` and `cancelSession` already `recordEvent` — read the timestamp for the guard from a field, not the ledger: add `endedAt` / `cancelledAt` patches in the forward mutations if the schema doesn't already carry them (check `convex/schema.ts`; if adding, they're optional numbers, cleared by the corresponding back-edge).
- **Ledger:** append `session.reopened` / `session.restored` events mirroring the existing `recordEvent` call shape in `endSession`/`cancelSession` (~:737–800). Never touch the prior events.
- **Digest re-arm:** `cancelSession` calls `cancelPrepDigest` and clears `prepDigestJobId` (~:785–790). `restoreSession` must re-arm via the same `schedulePrepDigest` path `createSession` uses — mirror that call exactly, and only when `scheduledAt` is still in the future (a restored past session gets no digest job, same as creating one in the past — check how `createSession` guards this and match it).
- **Reopen semantics:** `reopenSession` sets status back to `live` and clears `endedAt`. It does NOT touch synthesis/brief state — a write-up drafted against an ended session stays; ending again later is a fresh `session.ended` event.
- **Cascade check (do this FIRST):** read `convex/delegations.ts` (#66's lifecycle cascade) and grep for `session.ended` / `session.cancelled` / status listeners. If ending or cancelling a session triggers cascades elsewhere, STOP and report DONE_WITH_CONCERNS describing what the back-edge would need to compensate — do not invent compensation without review.

- [ ] **Step 1: Cascade check** as above; record the answer in your report either way.
- [ ] **Step 2: Failing tests.** In `convex/sessions.test.ts`, using the repo's existing convex-test idiom (mirror `convex/briefs.test.ts` setup): `reopenSession` restores `live` within the window; refuses after 10 minutes; refuses on a `scheduled` session; `restoreSession` restores `scheduled`, re-arms a digest job (assert `prepDigestJobId` set) for a future `scheduledAt` and not for a past one; both append the compensating ledger event; both refuse for non-managers. Also one test locking Task 1's server refusal copy (`"is still about"` appears, `"isn't until in"` does not).
- [ ] **Step 3: Implement** the two mutations beside `endSession`/`cancelSession`, matching the module's existing structure (args validators, `requireManage`, `refuse()` for illegal transitions, `recordEvent` last). 10-minute constant lives beside `MAX_EARLY_START_MS`-style constants with a one-line doc comment saying why it exists (an undo is a toast-length regret, not a time machine).
- [ ] **Step 4: Suite + typecheck** — PASS.
- [ ] **Step 5: Commit.**

---

### Task 4: End confirms everywhere; End and Cancel offer undo

**Files:**
- Modify: `app/(app)/app/sessions/[sessionId]/_components/manage.tsx` (End at ~:90–104, Cancel at ~:116–128, doc comment at ~:29–40)
- Modify: `app/(app)/app/sessions/[sessionId]/_components/live-session.tsx` (projector End at ~:102–121)

**Interfaces:**
- Consumes: `reopenSession`, `restoreSession` (Task 3); `ConfirmAction`; `useToast` from `app/(app)/app/_components/toast.tsx`.

- [ ] **Step 1: End → `ConfirmAction`, both sites.** Replace the bare buttons in `manage.tsx` and `live-session.tsx` with `ConfirmAction` (`label="End session"`, `confirmLabel="End it"`, `cancelLabel="Keep going"`, `tone="faint"`; size to match each site). The projector site loses its hand-rolled classes — `ConfirmAction` brings the standard treatment including `pressable` (the audit flagged the projector button as missing it).
- [ ] **Step 2: Undo toasts.** After a successful end: `toast({ message: "Session ended.", action: { label: "Undo", onAction: () => void reopenSession({ sessionId }) } })`. After a successful cancel: `toast({ message: "Session cancelled.", action: { label: "Undo", onAction: () => void restoreSession({ sessionId }) } })`. Failures inside `onAction` must surface: wrap with the existing `run()` state in `manage.tsx`, and in `live-session.tsx` route through its local error state (or better, both sites call a small shared handler in `manage.tsx`-exports if that avoids duplicating the pair — implementer's call, but the two sites must not drift in copy).
- [ ] **Step 3: Rewrite the intent comment** at `manage.tsx:29–40`: both End and Cancel now arm first, and both are undoable for ten minutes; say why (a projector misclick in front of the lab is exactly the wrong moment for an irreversible act).
- [ ] **Step 4: Suite + typecheck + lint** — PASS. Manual-pass items: end from projector confirms; undo within toast lifetime restores `live`; cancel-undo restores the calendar row and its digest job.
- [ ] **Step 5: Commit.**

---

### Task 5: Quote cleaner in lib, applied at the four render sites

**Files:**
- Create: `lib/quotes.ts`
- Test: `lib/quotes.test.ts`
- Modify: `app/(app)/app/sessions/[sessionId]/_components/session-board.tsx` (~:244, ~:409), `outcomes.tsx` (~:315), `brief.tsx` (~:298)

**Interfaces:**
- Produces: `cleanQuote(raw: string, max: number): string` — collapse whitespace, strip inline citation debris, trim to a sentence boundary within `max`, ellipsis fallback. Callers pass their own cap; existing CSS `line-clamp`s stay as the visual backstop.

- [ ] **Step 1: Failing tests**

```ts
// lib/quotes.test.ts
import { describe, expect, it } from "vitest";
import { cleanQuote } from "./quotes";

describe("cleanQuote", () => {
  it("collapses whitespace", () => {
    expect(cleanQuote("attention  is\n all you   need.", 100)).toBe(
      "attention is all you need.",
    );
  });
  it("strips [nn] and [nn, mm] citation debris, healing the gap", () => {
    expect(
      cleanQuote("as shown in prior work [12] the model [3, 14] converges.", 100),
    ).toBe("as shown in prior work the model converges.");
  });
  it("cuts at the last sentence end that fits", () => {
    expect(
      cleanQuote("First point. Second point continues well past the cap.", 20),
    ).toBe("First point.");
  });
  it("falls back to a word boundary with an ellipsis when no sentence fits", () => {
    expect(cleanQuote("one unbroken clause that runs long", 15)).toBe("one unbroken…");
  });
  it("keeps short quotes untouched", () => {
    expect(cleanQuote("Short and whole.", 100)).toBe("Short and whole.");
  });
  it("only trusts a sentence end past forty percent of the cap", () => {
    // "Dr." at position 3 is not a resting place worth cutting to.
    expect(cleanQuote("Dr. Vaswani proposed attention mechanisms", 30)).toBe(
      "Dr. Vaswani proposed…",
    );
  });
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**

```ts
// lib/quotes.ts
/**
 * A quote lifted from a PDF text layer arrives with the paper's plumbing
 * still attached: linebreak whitespace and the bracketed citation markers
 * that mean something in the bibliography and nothing on a passage card.
 * This trims a quote for display as an address — enough to find the
 * passage — preferring to end where a sentence does.
 */
const DEBRIS = /\s*\[\d+(?:\s*[,–-]\s*\d+)*\]/g;

export function cleanQuote(raw: string, max: number): string {
  const flat = raw.replace(DEBRIS, "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) {
    return flat;
  }
  const head = flat.slice(0, max);
  // The last sentence end that fits — but only when it leaves enough of the
  // quote to be an address; "Dr." three characters in is not a resting place.
  const sentenceEnd = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("? "),
    head.lastIndexOf("! "),
  );
  if (sentenceEnd >= max * 0.4) {
    return head.slice(0, sentenceEnd + 1);
  }
  const wordEnd = head.lastIndexOf(" ");
  return `${(wordEnd > 0 ? head.slice(0, wordEnd) : head).trimEnd()}…`;
}
```

(If the sentence-boundary test demands `sentenceEnd + 1` land after the period, adjust the arithmetic until the tests — which are the spec — pass without weakening them.)

- [ ] **Step 4: Apply.** Caps chosen to sit just above what each clamp can show, so CSS rarely cuts mid-thought: `PassageCard` (`session-board.tsx:244`) → `cleanQuote(passage.quote, 280)`; `FloorNote` (~:409) → `cleanQuote(note.anchor.quote, 160)`; `OutcomeBody` (`outcomes.tsx:315`) → `cleanQuote(outcome.citation.quote, 160)`; brief own-notes (`brief.tsx:298`) → `cleanQuote(note.anchor.quote, 160)`. Do NOT touch the four existing `elide()` copies (digest/brief-assemble/pickerLabel/synthesis prompt — different caps for stated reasons; unifying them is flagged backlog, not this task).
- [ ] **Step 5: Suite + typecheck** — PASS. **Step 6: Commit.**

---

### Task 6: A spine you can read

**Files:**
- Modify: `app/(app)/app/sessions/[sessionId]/_components/session-board.tsx` (`SessionSpine`, ~:75–117)

The audit found five causes (`audit.md` §4). Fix within these constraints — keep the live `flex-grow` transition, ontology order, only-present-types:

- [ ] **Step 1: Floor and height.** Bands: `style={{ flexGrow: count, flexBasis: "10px", backgroundColor: typeStyle(type).ink }}` with `flexShrink: 0` — every present type gets a visible ≥10px band; proportions still dominate for real counts. Track: `h-1.5` → `h-2.5`.
- [ ] **Step 2: One accessible source.** Drop `aria-hidden` from the legend `<ul>` and drop the `role="img"`/`aria-label` duplication on the strip — the strip becomes `aria-hidden="true"` decoration and the legend becomes the single source (order and content already match). The list gains `aria-label={`${notes.total} notes in this session`}`.
- [ ] **Step 3: Legible legend.** Counts leave the type ink: label stays in `typeStyle(type).ink`, the count renders in a sibling `<span className="text-ink tabular-nums">`. Keep 11px caps for the label but drop the tracking to `tracking-[0.08em]` — legibility over airiness at this size.
- [ ] **Step 4: The `note` band.** `note`'s ink is `--ink-faint` and unreadable on `bg-rule` in dark mode (audit §4.3). In the spine only, render `note`'s band as `var(--ink-muted)` (a local mapping in `SessionSpine`, one ternary with a comment saying why — do NOT edit `ontology.ts`, whose ink is load-bearing everywhere else).
- [ ] **Step 5: Suite + lint** — PASS (this is style-only; no unit surface). Manual-pass item: 1-of-40 type visible; dark-mode note band distinguishable from track.
- [ ] **Step 6: Commit.**

---

### Task 7: Citations that count and land

**Files:**
- Create: `lib/citations/numbering.ts`
- Test: `lib/citations/numbering.test.ts`
- Modify: `app/(app)/app/sessions/[sessionId]/_components/synthesis.tsx` (~:737–745), `brief.tsx` (~:523–531), `session-board.tsx` (`PassageCard`, `annotationAnchorId` emission), `lib/export/markdown.ts` (~:53–55) + its existing test

**Interfaces:**
- Produces: `citationNumbering(sections: ReadonlyArray<{ annotationIds: ReadonlyArray<string> }>): Map<string, number>` — first-appearance order across sections, 1-based, stable for repeat citations. (C3 later extracts server-side citation parsing into `lib/citations/` — same directory by design; coordinate names, don't merge concerns.)

- [ ] **Step 1: Failing tests**

```ts
// lib/citations/numbering.test.ts
import { describe, expect, it } from "vitest";
import { citationNumbering } from "./numbering";

describe("citationNumbering", () => {
  it("numbers by first appearance across sections", () => {
    const map = citationNumbering([
      { annotationIds: ["b", "a"] },
      { annotationIds: ["c", "a"] },
    ]);
    expect(map.get("b")).toBe(1);
    expect(map.get("a")).toBe(2);
    expect(map.get("c")).toBe(3);
  });
  it("is stable for repeats — a note keeps its number", () => {
    const map = citationNumbering([
      { annotationIds: ["a"] },
      { annotationIds: ["a", "b"] },
      { annotationIds: ["b"] },
    ]);
    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toBe(2);
    expect(map.size).toBe(2);
  });
  it("returns an empty map for no sections", () => {
    expect(citationNumbering([]).size).toBe(0);
  });
});
```

- [ ] **Step 2: Implement** (a ~10-line fold — walk sections in the order given, assign `map.size + 1` on unseen ids). Callers pass sections already in display order: synthesis/brief walk `SECTION_ORDER` — build the map from the SAME ordered array the page renders, in the page/component that already owns it, and pass it down.
- [ ] **Step 3: Fix the three render sites.** Replace `Note {position + 1}` with `Note {numbering.get(id)}` in `synthesis.tsx` and `brief.tsx`; in `lib/export/markdown.ts`, thread the same map (build it inside `sessionWriteUpToMarkdown` from its sections argument so export needs no new parameter) and update `lib/export/markdown.test.ts` to assert two sections citing the same annotation print the same number, different annotations print 1, 2, 3….
- [ ] **Step 4: Make the anchors real.** Today only `FloorNote` emits `id={annotationAnchorId(...)}` — citations to the four `AT_THE_PASSAGE` types, to replies, and to out-of-session notes are dead links (audit §5). Two moves:
  1. `PassageCard` emits `id={annotationAnchorId(note._id)}` on each note row it renders (the audit says it currently emits none).
  2. The pages compute the set of ids that actually have anchors on screen (passages within `MAX_PASSAGE_CARDS`, floor notes, replies if rendered — derive it in `session-notes.ts` beside `groupSessionNotes` so it's pure and testable: `anchoredIds(notes: SessionNotes): Set<string>`, with a test) and citation links render as `<a>` only when `anchored.has(id)`; otherwise the same `Note N` text unlinked (`<span>` with the same styling minus underline affordance). A number that scrolls nowhere must not promise to.
- [ ] **Step 5: Suite + typecheck** — PASS. Manual-pass items: two synthesis bullets citing different notes show different numbers; clicking a passage-type citation scrolls to its card; an out-of-session brief citation shows a number without a link.
- [ ] **Step 6: Commit.**

---

### Task 8: The way back reads as a way back

**Files:**
- Modify: `app/(app)/app/library/[paperId]/read/_components/reader.tsx` (~:1161–1172)
- Modify: `app/(app)/app/sessions/[sessionId]/_components/session-board.tsx` (~:183–189, ~:220–223)

Note: this task edits reader files. The TIMELINE §5 fence ("nothing touches the reader until A1 merges") is down — A1 merged as #72 — but the allowlist above is still exact.

- [ ] **Step 1: The link.** The "In session" pill (`reader.tsx:1164–1172`) becomes a navigational sibling of `← Paper` (~:1109–1114): visible label `← Session`, `aria-label="Back to the session"`, same treatment as `← Paper` (`font-sans text-sm text-accent underline-offset-4 hover:underline`, `shrink-0`), placed immediately after `← Paper` in the row. Keep the `href={`/app/sessions/${sessionId}`}` exactly. The header is two fixed-height non-wrapping rows (comment at ~:1101–1106) — the swap must not grow the row; if both links plus the export cluster overflow at 1024px, drop the pill styling remnants, not the label.
- [ ] **Step 2: Close the loop at full speed.** `MarginElsewhere`/`PassageBoard` overflow links into the reader are raw `<a href>` (`session-board.tsx:183`, `:220`) — full page reloads out of a live session. Swap both to `next/link` `<Link>` with identical hrefs (they carry `?session=` — load-bearing, keep it).
- [ ] **Step 3: Suite + lint** — PASS. Manual-pass items: reader entered from a session shows `← Paper` then `← Session`; both navigate client-side; board overflow link no longer full-reloads.
- [ ] **Step 4: Commit.**

---

## Out of scope (flagged in audit §d, deliberately not here)

Unifying the four `elide()` copies; `MAX_PASSAGE_CARDS` vs spine count disagreement; `getSessionContext` dead-query check; `PresenterNotes` internal status guard; outcomes "Reopen" confirm; broader `pressable` sweep beyond buttons these tasks already touch. Carry them to the final review's backlog list.

## Manual browser pass (after final review, before PR)

Collect every "manual-pass item" named in Tasks 2, 4, 6, 7, 8 plus: undo toast outranks the confirm dialog (z-60 over z-50 — the audit notes the layering anticipated exactly this flow); Start hint copy renders with real times; spine in both themes.
