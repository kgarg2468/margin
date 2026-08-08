# Architecture

Margin is a collaborative journal club for research labs. This document is the
condensed, public version of the design that PRs are built against: what the
system stores, why it stores it that way, and what it deliberately refuses to
store.

## Stack

Next.js 15 (App Router, React 19) on the front, Convex on the back — database,
file storage, scheduled functions, actions, and auth all in one deployment.
Auth is Convex Auth's Password provider: email and password, hashed on the
deployment, no third-party identity service. Everything lab-scoped is
authorized against the `memberships` table; a `labId` from the client is a
claim, never a fact.

## The Ledger

`events` is an append-only log of every meaningful act in a lab — a lab
created, a member joined, a paper added, an annotation written, edited, or
replied to, a session scheduled, started, ended, synthesized. Rows carry full
provenance (actor, lab, paper, session, annotation, timestamp) and are never
updated or deleted. `convex/lib/ledger.ts` is the only insert path.

This is the load-bearing decision. It is deterministic, it needs no model, and
it makes point-in-time queries true by construction: what did this lab know in
March, and who knew it? A competitor can clone the UI in a month and still not
have a lab's path-dependent history.

## Passage anchoring

Annotations attach to passages, not pages. Each anchor carries redundant W3C
Web Annotation-style selectors: a **TextQuoteSelector** (`quote` plus `prefix`
and `suffix` context) and a **TextPositionSelector** (`start`/`end` offsets
into the page's extracted text, with `pageIndex`).

The redundancy is the point. A lab's preprint PDF and the publisher's version
disagree about pagination, ligatures, and line breaks; position offsets alone
break, quotes alone are ambiguous. Together they support fuzzy re-anchoring
against text extracted client-side with pdf.js at upload time. This is treated
as its own module with its own tests, not as incidental glue.

## Typed-pair collisions and the digest policy

Convergence detection is deterministic, with no model in the loop. Two
annotations **collide** when they are written by different members, their
anchors overlap or share a paper section, and the pair of annotation types
lands in a cell of a hand-written type-pair matrix:

| pair | reading |
| --- | --- |
| hypothesis × hypothesis | convergent theorizing |
| hypothesis × critique | contradiction |
| open-question × definition | resolution |
| connection × connection | project collision |

Delivery is per-recipient and boundary-scheduled. Each member has a `seenCursor`
per paper or session; their deltas are the ledger events they have not caught up
on. Nothing is pushed on write.

The shape of a digest is fixed by simulation over lab sizes 5–25 (`digest_gold5`):
gold collisions become individual passage-addressed lines, everything else
coalesces to one line per paper, and the whole digest is capped at five items.
That retains 99.7–100% of gold events at p90 ≤ 5 items. Paper-level granularity
was measured at 6–12% precision and rejected — passage-level or nothing. Digests
are computed at T−2h before a session and refreshed at session start, because
roughly a third of prep happens inside the last 24 hours.

## Privacy constitution

Non-negotiable, and enforced by the schema rather than by policy:

- **No dwell or read tracking.** There is no `reads` table, no `viewedAt`
  field, and no read event type. The only evidence of engagement Margin ever
  stores is an annotation someone chose to write.
- **No per-member reading dashboards**, for anyone, including the PI.
  Aggregate views only, and only at k ≥ 3.
- **Annotations default to lab-visible inside a journal club session** — prep
  is inherently collaborative — and **private outside one**. One tap either
  way, at creation or later.
- **Members own their data.** Leaving a lab removes their private annotations;
  shared ones remain, still attributed.

## Synthesis

Post-session synthesis is one long-context model call over that session's
annotations, threads, and presenter notes. Its output is constrained to quote
and attribute existing annotations — it never generates claims — and is
structured by annotation type: open questions, critiques, connections,
definitions. The presenter edits and approves it before it lands. Roughly
$0.30 per lab per month.

The posture is deliberate. Researchers distrust tools that put words in their
mouths, so Margin's model layer only ever rearranges what the lab already
said.

## Annotation ontology

Seven types: `note` (the untyped default) plus `hypothesis`, `method-note`,
`critique`, `definition`, `connection-to-own-work`, `open-question`. Typing is
one tap and never required. Type usage is instrumented, and the measured
distribution decides what gets built after month six.

## Data model

`convex/schema.ts` declares every table up front, including ones whose
functions arrive in later PRs — the schema is the contract.

| table | holds |
| --- | --- |
| `users`, `auth*` | Convex Auth identities |
| `labs` | research groups |
| `memberships` | user ↔ lab, role `pi` or `member` — the authorization root |
| `invites` | 8-character join codes, reusable until expiry |
| `papers` | metadata, stored PDF, per-page extracted text, ingest status |
| `sessions` | one journal club meeting: lab, paper, presenter, lifecycle |
| `annotations` | anchor, type, body, visibility, `parentId` for threads |
| `events` | the append-only Ledger |
| `seenCursors` | per-recipient staleness, per paper or session |
| `digests` | materialized `digest_gold5` output for one member at one boundary |
