# Wave 5 — P3: solo catch-up mode

**Status:** DONE_WITH_CONCERNS (concerns are flags, not defects — see below)
**PR:** https://github.com/kgarg2468/margin/pull/81 (open, not merged)
**Branch:** `kgarg2468/wave5-p3` (worktree `/tmp/margin-p3`), 2 commits.

## Commits

- `3ebc88a` — Solo catch-up: in a lab of one, the colleague is your past self
- `7cfdb21` — Solo recall: the echo, the ghost, and the fortnight, as tests

## The semantics I chose

> When the lab has exactly one member — counted from `memberships` at read
> time — the arrival hands back the member's own notes that are older than
> **both** the window this arrival covers (`plan.since`, their last "I'm caught
> up") **and** `SOLO_RECALL_MIN_AGE_MS` (14 days), on the papers the ledger says
> they have written on since.

Each half of the exclusion catches a case the other cannot:

- The **window** keeps this visit's writing out. Without it the note typed
  twenty minutes ago returns as a discovery — an echo, which teaches the reader
  the card is noise.
- The **age floor** keeps last Tuesday out. A member who caught up two days ago
  has a two-day window; a note from five days ago is behind it and is still this
  week's work.

A fortnight rather than a month so the first rung can fire at all: a longer
floor demos better and is invisible for a month to a new solo account.

The **trigger is unchanged** — the ledger still names the papers. A solo lab's
recall fires because *you* have been writing on a paper again, which is the only
moment "you already wrote about this in March" is worth saying rather than
nagging. A solo member who returns having written nothing gets nothing.

Two tiers, oldest-first within both (the inverse of every other ranking in the
module: those report news, this reports the opposite of news, so the cap should
cut the note nearest to memory rather than the one furthest from it):

1. a recalled note whose passage was annotated **again** this visit — the only
   line permitted to say "on this same passage", decided by `anchorOverlap`, the
   same test the collision detector uses;
2. everything else, coalesced per paper.

Encoded in `SOLO_RECALL_MIN_AGE_MS`'s docblock, the `## A lab of one` section of
`catchUp`'s docblock, and `assembleRecall`'s.

## The non-member invariant

Membership is now the pool filter in **both** digest paths — `catchUp` and
`buildSessionPrep` — replacing implicit trust in an annotation's `labId`. An
author with no membership row can no longer be a delta or the far half of a
collision. Derived from membership data alone; no dependency on the parallel
worker's ghost-author seed code.

## Tests

20 new in `convex/digests.solo.test.ts`; suite 1577/1577 green.

- Echo, both halves: this visit's note refused; a note inside the window refused
  even at 60 days; a note behind the window but younger than a fortnight refused.
- Ghost: a non-member author yields no digest, in the arrival path and in a
  session's prep.
- Redaction: a private note and a deleted note are the only history, and nothing
  is built. The solo pool is still pinned to `by_paper_and_visibility` at "lab"
  on purpose — a digest row outlives the lab's size and nothing re-reads its
  provenance when a second member joins.
- Two-member lab: own old notes never surface (today's behavior exactly).
- Idempotence in the solo path; `recallWhen`'s three registers;
  `assembleRecall`'s tiering, ordering, coalescing and dropped-count.

`delegations.fixtures.ts` gained `gt` on its constraint builder (see flags).
Ledger rows are seeded through `recordEvent` with the clock moved, per the house
rule and `sessions.test.ts`'s precedent.

## Gates

`npm test` ✅ · `npx tsc --noEmit` ✅ · `npm run typecheck:convex` ✅ ·
`npx eslint .` ✅ · `npx next build` ✅ · `npx convex dev --once` against
festive-boar-562 ✅ (Convex's analyzer accepts the module and the plain exports).

## Flagged

1. **No live end-to-end.** `_creationTime` cannot be set in a real deployment, so
   a live solo digest needs notes genuinely 14 days old. Not reachable today
   without shipping a lowered constant. Leaned on tests, which drive the real
   `catchUp` handler with the clock under control.
2. **Out-of-allowlist, 5 lines:** `convex/delegations.fixtures.ts` gained `gt` on
   its constraint builder. `catchUp`'s `by_lab_and_at` read calls `q.gt`, which
   the fixture did not implement and would have thrown on. Strictly additive; no
   existing test changes behavior. Without it there is no test of `catchUp`.
3. **`lib/digest/engine.ts` left alone** (outside allowlist), so `assembleRecall`
   lives in `convex/digests.ts` and re-derives quote elision. Ontology nouns are
   derived from the type token rather than copied. Folding recall in beside
   `assembleDigest` is the natural home once that file is free.
4. **Schema frozen**, so a solo row is stored as `kind: "coalesced"` and "built
   from the reader's own margin" is inferred client-side from the lab's current
   size. A solo digest still unread when a second member joins would be captioned
   with colleague words. `kind: "recall"` is the clean fix; needs
   `convex/schema.ts`.
5. **Shared dev deployment churn:** `npx convex dev --once` from this worktree
   dropped `labs.by_personal_for` and `demoSeeds.by_revision` — indexes a
   parallel wave had pushed to festive-boar-562. Nothing here touches them; that
   wave will re-push.
6. **Stale generated file on main:** regenerating left `convex/_generated/api.d.ts`
   with an added `crons` import — main's checked-in copy is stale and unrelated to
   this work. Reverted to keep the diff focused; somebody should refresh it.
7. **Untouched by design:** `SessionDigest`/`buildSessionPrep` still exclude the
   caller's own notes, so a solo lab's *session prep* remains empty. Session
   boundaries were out of scope; if solo labs run sessions, that is the next rung.
