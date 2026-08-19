# Wave 5 · Track P item P2 — read-only share links

**Status:** DONE_WITH_CONCERNS
**PR:** [#86](https://github.com/kgarg2468/margin/pull/86) — open against `main`, **not merged**, not a draft
**Branch:** `kgarg2468/wave5-p2` (3 commits, all pushed)
**Worktree:** `/tmp/margin-p2`

The concerns are environmental and disclosed below (a shared dev deployment collision with a
parallel branch, and one pre-existing wrong status code on an untouched route). Nothing about the
feature itself is known-broken.

---

## Commits

| sha | subject |
|---|---|
| `5d119ae` | P2: a link is a capability, and consent decomposes per author |
| `2fd3abb` | P2: the page a stranger sees, and the guard that learned a fourth secret |
| `964fe6a` | P2: the panel that mints a link, and the tickbox that is nobody else's to tick |

Each carries the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

## Gates

All five clean on the final tree (after reverting the temporary schema widening described below):

- `npm test` — **1618 passed, 83 files**
- `npx tsc --noEmit` — clean
- `npm run typecheck:convex` — clean
- `npx eslint .` — clean
- `npx next build` — clean; `/s/[token]` builds as `ƒ` (dynamic), which is required for
  revocation-on-read

The privacy suite was mutation-tested rather than trusted. Deleting the opt-in gate from
`paperMargin` fails 4 tests; swapping the visibility index to `private` and dropping the
`revokedAt` check fails 11. Source restored and re-verified after each.

---

## What was built

### Backend — `convex/shares.ts` (new)

`view` is the only query in this codebase with no `requireUserId`. It returns a hand-built view
model, never a `Doc`, and `null` for every way a link can be dead — not a token, no such token,
revoked, artifact deleted, lab mismatch, signature gone. One answer for all of them.

**Paper shares — consent decomposes per author.** A note renders only if it is lab-visible *and*
its author has separately opted this paper in. Creating a share opts the sharer in and nobody
else. Private notes are excluded structurally: the read goes through `by_paper_and_visibility`
asking only for `lab`, so there is no post-read filter that a later edit could delete.

Where consent is absent the note is *absent*. The one exception: a top-level note that fails the
gates but has surviving shareable replies renders `REDACTED_NOTE_TEXT` and nothing else — no
body, no quote, no author name, no type, no status. A column of "withheld" placeholders would
publish the shape of what non-consenting members wrote.

**Synthesis shares — the sign-off is the consent.** Requires `canApprove` plus an existing
`synthesis`. `approvedWriteUp` returns `null` unless both `synthesis` and `synthesisApprovedAt`
are set *and* `countWithdrawn(snapshot, stillShared) === 0`. Stricter than the authed banner: out
there nobody can be asked to review a struck line, and prose has no per-line remedy. Only the
approved copy travels — the generated draft cannot reach a public page. Re-approving restores the
same link.

Redaction is not reimplemented. `paperMargin` reuses `isStillShared` and `redactWhenAnyWithdrawn`
from `lib/citations/` — the same authority the briefs and findings apply.

`publicName` returns `user?.name ?? "A lab member"` with **no email fallback**, deliberately unlike
`annotations.displayName`, which is correct behind a membership check and wrong here.

### Token — `lib/shares/token.ts` (new)

26 symbols over a 32-symbol ambiguity-free alphabet = **130 bits**, drawn from
`crypto.getRandomValues` with `byte & 31` (unbiased 5-bit draws). Looked up by its own `by_token`
index, never a document id. `looksLikeShareToken` is a cheap shape filter, not an authorization
decision — the index is what says no, and a test asserts a well-formed stranger gets that far.

### Schema — `convex/schema.ts` (3 additive edits, kept minimal for PR #82's merge)

- `shareKind` / `shareDoc` (discriminated union, inserted before `eventDoc` — it references
  `shareKind` at module-evaluation time)
- three `eventDoc` variants: `share.created`, `share.revoked`, `share.optin_changed`
- two tables at the end of `defineSchema`: `shares` (`by_token`, `by_paper`, `by_session` — the
  latter two include `revokedAt` so the live-share lookup is an exact indexed read, not a scan)
  and `paperShareOptIns`

`revokedAt` is set once and never cleared: revoking is final and a new link is a new row.

### HTTP — `convex/http.ts` (appended; authed `/pdf` untouched)

`/shared-pdf` takes the token as its only permission and **accepts no `Authorization` header at
all**. Returns `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.

### Public surface — `app/(public)/` (new)

Its own route group so a share page cannot inherit the auth provider, the shell, or the assumption
that there is a signed-in member with a lab. **No Convex client is mounted**: the page reads once
per request on the server via `fetchQuery`, with `export const dynamic = "force-dynamic"`. That is
what makes revocation take effect on the next load, and it keeps an anonymous reader from opening
a live subscription — a socket per viewer is a connection record with the lab's name on it.

Metadata carries no artifact title (a title travels into link previews and history sync); robots
noindex from the layout, `X-Robots-Tag` from `next.config.ts`.

The paper view renders pages to canvases from `/shared-pdf` and draws cards beside them. It is
deliberately **not** the authed reader.

### Management UI

- `app/(app)/app/library/[paperId]/_components/share-panel.tsx` — create / copy / revoke, plus the
  caller's own opt-in tickbox and the opted-in count. Every member sees the link, not only its
  creator: somebody whose notes could be on the other end of a URL is owed the knowledge that the
  URL exists, which is what makes the opt-in a choice rather than a setting nobody found.
- `app/(app)/app/sessions/[sessionId]/_components/synthesis-share.tsx` — much smaller, because
  the sign-off already is the consent. Explains a link gone quiet from a withdrawn citation
  rather than deciding anything.

---

## Live verification (dev deployment `festive-boar-562`)

Signed in as `elena.whitfield@margindemo.dev` (PI, Computational Memory Lab).

Test paper had **16 lab-visible notes: 8 by Elena, 8 by Marcus Feld**, with only Elena opted in
(auto, from creating the share).

1. **Created** the link from the panel → `/s/dtgqfs9cmpdk5duzharx5ujpp2` (26 chars, in alphabet).
2. **Fetched with no cookies at all** (`curl`, not a browser session): `200`, paper title,
   citation, DOI, and Elena's notes. Verified programmatically against a snapshot export:
   **Elena 8/8 present, Marcus 0/8 present, the string "Marcus" absent from the response.**
   `X-Robots-Tag: noindex, nofollow, noarchive` present; `<meta name="robots">` present; no
   `Set-Cookie`; no signup wall.
3. **PDF:** `/shared-pdf?token=…` → `200`, 2 928 794 bytes of `application/pdf`,
   `Cache-Control: private, no-store`, correct `Content-Disposition`. No token → `400`.
   Well-formed stranger token → `404`. The authed `/pdf` with no header → `401`, and the share
   token presented as a bearer to `/pdf` **does not deliver the file**.
4. **Revoked** from the panel (through the confirm dialog). Page → **`404`**. PDF → **`404`**.
   A never-minted token → **`404`**. Indistinguishable, as intended.

Not exercised live: the private-note exclusion (the demo lab has no private notes on that paper)
and a second member flipping their own opt-in (no password for the Marcus account). Both are
covered by `convex/shares.test.ts`, including a structural assertion that private notes are never
*queried*.

---

## Flagged

1. **`convex/credentials.guard.test.ts` was edited — review this part of the diff first.** The
   guard correctly flagged the token in four public returns validators. A share token *is* a
   bearer secret; it is also the only one in this codebase a member is meant to be handed. The
   four are named one at a time rather than exempted by a `shares.*` prefix, because a prefix
   would silently wave through a *new* function on the module that grew a token in its answer. A
   new assertion holds `shares.view` — the one function answering anonymous callers — to carrying
   no token at all. `shares` was added to the credential-holding tables list with its reasoning.

2. **`toBlocks` extracted** from `synthesis.tsx` to `lib/prose/blocks.ts` (behaviour unchanged).
   This is the one thing in the diff that is a refactor rather than an addition. Justification: a
   stranger now renders the same approved copy, and two copies of a parser whose entire job is to
   *not* build HTML out of user input is two places for one of them to grow a feature — the one
   that grows it being the one facing the open web.

3. **Shared dev deployment collided with a parallel branch.** `npx convex dev --once` failed
   schema validation against a `labs` row carrying `personalFor` — a field from an unmerged
   parallel branch (Track P item P1, personal library). Worked around by temporarily adding
   `personalFor: v.optional(v.id("users"))` to the `labs` validator **locally and uncommitted**,
   pushing, verifying, then `git checkout convex/schema.ts`. **The committed schema does not
   contain `personalFor`.** That push also **dropped three indexes belonging to other branches**:
   `labs.by_personal_for`, `demoSeeds.by_revision`, `demoSeeds.by_storage`. They return on that
   branch's next `convex dev --once`. This is exactly the hazard the house rule warned about.

4. **`/pdf` answers `500`, not `401`, to a malformed bearer token.** Pre-existing, on a route this
   branch does not touch (Convex auth throws on a non-JWT). It does not leak the file. Wrong
   status code, worth a one-line fix on some other branch.

5. **No `myShares` "all my links" screen.** The prompt's sketch mentioned one; I judged the
   per-artifact panels to be the real management surface, and a global list of everything a lab
   has published is the first vertebra of a feed. Deliberate omission, easy to add.

6. **The public paper view loses the passage highlight.** Cards name their quote and page rather
   than being drawn on the passage, because tying a card to a rectangle needs the text layer and
   anchor-resolution machinery from the authed reader. Correct trade for rung 0; worth revisiting
   if share links get real use.

7. **`gh` CLI auth is broken on this machine** (`The token in keyring is invalid`). The PR was
   opened by reading the working credential out of the git credential helper into `GH_TOKEN` for
   that one command. Worth a `gh auth login` at some point.

8. **A leftover browser session from a parallel branch** ("Wave5 OneShot") was signed in at
   `localhost:3001` and was signed out to run this verification. Port 3000 is occupied by another
   workspace's dev server, which was not touched.
