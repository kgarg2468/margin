# Design: The scout — agent delegation on the lab's open questions

**Status:** Draft v2, post red-team · 2026-08-09
**Reviewed by:** two independent adversarial passes (Claude Opus, GPT Sol) against the shipped code; all KILL/MAJOR findings addressed — see §13.
**Depends on:** actions/outcomes (#55), epistemic status (#60), search (#44), synthesis harness (#43), briefs (#53)
**Strategy context:** `docs/STRATEGY.md` §8 — the Linear move: Margin's native objects become work items for software agents *inside the existing harness* (provenance, approval, revocation), never a chatbot beside it.

---

## 1. The one-sentence feature

When the pre-session brief is built, a **scout** also runs over the session's carried-forward open questions and attaches a **finding** to each it can inform: a cited, revocable, proposed-not-accepted report of what the lab has already said that bears on the question — which a human may use to settle the question, or ignore.

## 2. Why the brief is the trigger (changed in v2)

Draft v1 proposed a "Delegate to scout" button. Review killed it on the design's own test: habits attach to events that already recur, and a discretionary button on a noun is exactly the no-trigger shape that dies of being forgotten. The brief chain already fires at T−2h before every session (`prepDigestJobId` → digest → brief), already has a human approval surface (`briefs.approve`), and already renders carried-forward open questions — the scout's input is sitting in the artifact the presenter already opens. So:

- **v1:** the scout rides the brief. No new trigger, no new notification, no button. The brief's "what is still open from last time" section gains findings.
- **v1.5:** an on-demand *Delegate* affordance on question rows (outcomes panel + open-question annotation cards), reusing the same tables and run path, with reactive status on the card (not notifications — see §13.2).
- **v2 (separate doc):** external literature scout.

This also restores strategy fidelity: `STRATEGY.md` ships the Presenter Agent in Phase 1 and defers the standalone scout to Phase 3; a brief-embedded scout is an upgrade to the shipped Presenter Agent, not a queue-jump.

## 3. Constitutional constraints (all repo-verified)

1. **Annotations are human speech.** A scout never writes an annotation, reply, or status. Findings live in their own table, rendered agent-styled — the synthesis/brief precedent.
2. **Machines never write epistemic status** (`lib/epistemic/status.ts:13-21`). A finding may describe and cite; only humans settle, adopt, or rule. The schema's reserved proposal-vs-assent slot is for a later suggestion feature, not this one.
3. **A job has no name.** Ledger `actorId` stays human. Brief-triggered scout events carry the **presenter** as actor with `trigger: "scheduled"` — the exact `brief.generated` precedent. v1.5 on-demand runs carry the requester.
4. **No agent principal in `users`.** The scout is a capability the lab invokes, not a member. If stage 3 needs per-agent identity, it becomes a dedicated registry table, never a `users` row.
5. **Lab-visible retrieval only, structurally.** The scout's gather reads `annotations.search_body` with `.eq("visibility", "lab")` — the index carries `visibility` as a filterField precisely so the rule holds *inside* the index. It never uses the private-interleave path, never reads private notes (not even the presenter's), never reads presenter notes. A dedicated guard test asserts no private row can reach a prompt.
6. **The scheduled-reader authz mode (named honestly; changed in v2).** Review established that no shipped precedent combines scheduled execution + lab reads + a model call: synthesis is a user-invoked public action whose internal functions re-derive authorization ("never inherited," `synthesis.ts:1069-1072`), and the scheduled brief chain makes no model call. The scout's gather/store are therefore **delegation-specific internal functions** that (a) take `labId` from the stored delegation row, (b) enforce the visibility filter structurally per §3.5, and (c) re-validate subject state on entry (the brief chain's re-guard precedent, `briefs.ts:357-388`). This is a new, deliberately narrower mode — documented in code as such, not disguised as reuse of the public gates.
7. **Whole-item redaction (stricter than synthesis; changed in v2).** Synthesis keeps an item while *any* citation survives — acceptable there because attribution is per-name, but a KILL here: a finding paraphrasing sources A+B would keep leaking withdrawn A's substance while B survives. Rule for findings: **an item is redacted when any of its citations becomes unavailable.** Re-checked at gather, at store, and on every read.
8. **Citations are mechanical or the item dies.** The `[A#]` label gate, citation-derived paper IDs, per-item drop-and-count, loud failure on empty output — extracted from synthesis into `lib/citations/` and shared, so there is one gate implementation.

## 4. Scope

**v1 — brief-embedded corpus scout.** Input: the brief's carried-forward open questions — these are **`open-question` annotations with no replies from prior sessions** (`lib/brief/assemble.ts` filters `a.type === "open-question"`; brief items store `annotationIds`; the brief never reads the `actions` table), capped by the shipped per-section `MAX_SECTION_ITEMS = 6`. **The v1 subject is therefore an `Id<"annotations">`;** action-row subjects arrive with v1.5's on-demand runs from the outcomes panel. Retrieval: lab-visible corpus (annotation search index + the brief's persisted collision lines + epistemic-status fields read mechanically). Output: at most one finding per question per brief run. One model call per brief covering all questions (bounded, §6).

**v1.5 — on-demand delegation** on question rows; same tables, same run path, requester as actor, reactive card status.

**Explicitly out:** chat; agent-written annotations/replies/status; auto-settling; notifications (§13.2); external retrieval; multi-step plans; MCP server (§9 keeps the shape ready); `status_note` finding items and model-written coverage summaries (§13.3).

## 5. Data model

### 5.1 `delegations`

```
delegations: {
  labId: Id<"labs">,
  agentKind: "scout.corpus",
  trigger: "brief" | "manual",           // manual = v1.5
  briefId?: Id<"briefs">,                // brief-triggered runs
  annotationId?: Id<"annotations">,      // v1 subject: the carried-forward open-question annotation
  actionId?: Id<"actions">,              // v1.5 subject: outcomes-panel question row
  requestedBy: Id<"users">,              // presenter (brief) or requester (manual)
  requestedAt: number,
  status: "queued" | "running" | "returned" | "empty" | "failed" | "cancelled",
  startedAt?: number,
  lease?: string,
  leaseAcquiredAt?: number,              // expiry: DELEGATION_LEASE_MS (3 min, synthesis precedent)
  failureReason?: string,
  findingId?: Id<"findings">,
}
  .index("by_lab_and_status", ["labId", "status"])   // bounded active-count reads
  .index("by_lab_and_time", ["labId", "requestedAt"]) // rolling daily-budget range read
                                                      // (rows are never deleted, so the
                                                      // budget cannot scan by status)
  .index("by_annotation", ["annotationId"])           // v1 subject lookups
  .index("by_action", ["actionId"])                   // v1.5 subject lookups
  .index("by_brief", ["briefId"])
```

`returned` vs `empty` is the honest-null distinction: `empty` = retrieval itself found nothing; a run whose items all died at the citation gate is `failed` ("found nothing citable").

Caps: per-lab active cap (via `by_lab_and_status`), **plus a rolling per-lab daily run budget** (cost bound, not just concurrency — review finding) computed as a `by_lab_and_time` range read over the last 24h. Per-requester fairness for v1.5 manual runs adds its own index when v1.5 lands — not before. One active delegation per subject (either subject kind, checked via its subject index); re-request returns the existing row. Rows are history — never hard-deleted; terminal rows are the audit trail.

### 5.2 `findings`

```
findings: {
  labId: Id<"labs">,
  delegationId: Id<"delegations">,
  agentKind: ...,
  items: Array<{
    text: string,                              // ≤ 600 chars, model prose
    citedAnnotationIds: Id<"annotations">[],   // label-validated, non-empty
    citedPaperIds: Id<"papers">[],             // derived from citations
  }>,
  coverage: {                                  // computed in code, never model prose
    annotationsSearched: number,
    papersTouched: number,
    queriesRun: number,
  },
  droppedForCitation: number,
  model: string,
  generatedAt: number,
  supersededAt?: number,                       // set when a newer run for the same subject returns
  annotationId?: Id<"annotations">,            // denormalized from the delegation's subject at write —
  actionId?: Id<"actions">,                    // a subject index needs a stored field to exist
}
  .index("by_delegation", ["delegationId"])
  .index("by_annotation", ["annotationId"])    // newest non-superseded per v1 subject
  .index("by_action", ["actionId"])            // same, v1.5 subjects
```

Ordering rule: a thread renders the newest non-superseded finding; prior findings remain reachable from delegation history.

### 5.2b `findingCitations` (reverse lookup)

Citations live nested in `items`, and Convex cannot index into arrays — so the
withdraw cascade (§5.4) would otherwise be an unbounded findings scan. A join
row per cited annotation, written in the same mutation as its finding, gives
the cascade an indexed path:

```
findingCitations: {
  labId: Id<"labs">,
  findingId: Id<"findings">,
  annotationId: Id<"annotations">,
}
  .index("by_annotation", ["annotationId"])
  .index("by_finding", ["findingId"])
```

Rows are written atomically with the finding and are never updated; they are
lookup structure, not state. Read-time whole-item redaction (§3.7) remains the
defense of record — the join table is how the withdraw cascade *finds* stored
findings that cite an annotation, not what makes them safe.

### 5.3 Ledger events

`delegation.requested` · `delegation.returned` (`trigger`, `itemCount`, `droppedForCitation`) · `delegation.failed` · `delegation.cancelled`. Human `actorId` per §3.3; `recordEvent` only.

### 5.4 Subject lifecycle cascade (new in v2)

`actions.remove` hard-deletes on the stated premise that "no derived artifact cites one" — this design falsifies that premise, so the premise changes, not the design: **settle, remove, and withdraw-of-cited-annotation all cancel any active delegation on the subject (clearing its lease).** Settle/remove reach active delegations via `delegations.by_action`; withdraw reaches them via `delegations.by_annotation`. Withdraw additionally locates *stored* findings that cite the annotation via `findingCitations.by_annotation` (§5.2b), not by scanning — but it does **not** write `supersededAt`, which means only "a newer run for the same subject returned" (§5.2). A withdrawn or re-privatized citation is handled by read-time whole-item redaction (§3.7); an *in-flight* run that already gathered the annotation is unreachable from any index and is caught instead by the store-time "every citation still shared" re-check (§6.6). The `actions.ts` doc comment is corrected in PR A. Terminal delegation rows referencing a deleted action keep the id as a tombstone reference (rendered "question withdrawn").

## 6. Execution flow

1. **Enqueue.** `briefs.buildForSession`, after writing the brief (deterministic, instant — the scout must never delay or block the brief), collects the brief's carried-forward open questions and, if any, writes one `queued` delegation per question (respecting caps) and schedules `internal.delegations.runForBrief` — an **internalAction** orchestrating claim (internalMutation) → gather (internalQuery) → model call → store (internalMutation) — via `runAfter(0)` with the batch + a fresh lease per row.
2. **Claim (internalMutation, atomic).** Per delegation: re-validate — brief still exists and is this session's current brief, subject still open, not cancelled — then `queued → running`, stamp `startedAt`/`leaseAcquiredAt`. A retry that finds `running` (or any terminal state) **must not re-run the model call**: if the lease is expired it marks `failed`; otherwise it exits. (Scheduled actions can be retried on crash; the model call is guarded by state, not by hope.)
3. **Gather (internalQuery, scheduled-reader mode §3.6).** Question text → search query by code-side keyword reduction to the 200-char search cap (stated reduction, not a slice). Reads: lab-visible annotation search, the brief's already-persisted collision lines (collisions are computed by `detectCollisions` at brief build, not stored as a table — the gather reads the brief row rather than recomputing), and epistemic-status fields on annotations read mechanically. All untrusted text is serialized as **JSON in the prompt** — review showed `fence()` strips only the two synthesis tags, so tag-fencing is not reused; JSON serialization closes the delimiter-injection path.
4. **Model call.** Synthesis harness verbatim (raw fetch, strict `json_schema`, timeout, incomplete-output refusal, refusal parts), one call for the batch, `[A#]` labels issued per retrieved annotation, instructions: report only what labels support; no conclusions, no recommendations, no imperatives to the reader.
5. **Sanitize** via shared `lib/citations/` gates; items with zero surviving citations die; whole-item redaction rule (§3.7) applied.
6. **Store (internalMutation).** Requires: status `running` **and** matching unexpired lease **and** subject still open **and** every citation still shared (re-check at store, not just gather). Writes finding, supersedes prior finding for the subject, delegation → `returned`/`empty`, ledger event. Cancel clears the lease, so a cancelled run's store fails closed.
7. **Failure.** Catch → `failed` + user-facing `failureReason`; log detail to deployment logs only; no auto-retry of model calls; expired-lease cleanup marks abandoned runs `failed` (the "permanently occupied slot" fix).

## 7. UI

- **Brief:** "What is still open from last time" lines gain their finding beneath them — agent-styled card, per-item citations deep-linking to annotation/passage. Live statuses of cited claims are rendered **mechanically from the live rows** next to citations (no model prose about status). If the scout hasn't returned when the brief is opened, the line shows a quiet "scout is looking back…" that resolves reactively; the brief itself never waits.
- **Outcomes panel:** question rows show delegation status chips and the newest finding; server-decided per-row permissions (`canSettle` etc.) unchanged.
- **Finding card actions (humans only):**
  - *Settle with this* — extends `setSettled` with an optional validated `findingId`, recording provenance of what informed the settlement. Permissions unchanged.
  - *Adopt citations* — prefills a composer with **citation links only, never model prose** (review: prefilled prose is machine speech laundered into the human-speech table). The member writes their own words. Action-row subjects without a `citedAnnotationId` get *Settle with this* only (there is no thread to reply into — subject-specific affordances, per review).
  - *Dismiss* — client-side collapse only in v1 (no per-viewer server state; cut as gold-plating).
- **Empty/failed:** "Scout searched N annotations across M papers and found nothing citable" rendered as a legitimate answer, from `coverage`, not from the model.

## 8. Permissions

| Act | Who |
|---|---|
| v1 scout run | nobody presses anything — rides the brief chain; presenter is the ledger actor |
| v1.5 manual delegation | any lab member on a visible open question; cancel = requester or steward |
| Settle (with or without finding) | existing `setSettled` permissions, unchanged |
| Adopt citations | any member (creates their own annotation) |
| See findings | lab members |
| Write annotations / status / settlements | **never the agent** |

## 9. Stage-3 readiness (MCP)

The v1.5 mutations (`delegations.request`/`.cancel`/`listForSubject` — implementable for both subject kinds via `by_annotation`/`by_action`, `findings` reads) are the complete future external contract; an MCP server exposes exactly these plus search, through the same authz path. External agents get the delegation surface, never table writes. Nothing in v1 blocks this; nothing in v1 builds it.

## 10. Eval gate (rewritten in v2 — two instruments, honestly separated)

Review correctly split the v1 gate into two different measurements:

1. **CI invariant tests (block every PR):** convex-test fixtures asserting the *gates* — label validation, drop counting, whole-item redaction on withdrawal, store-time re-validation, and above all **no private annotation can ever reach a prompt or a finding** (a guard test in the `privacy.guard.test.ts` tradition). Stub model; deterministic.
2. **Offline quality run (blocks v1 *launch*, not each PR):** ground truth from the ledger, not invented — for historical *settled* questions, the annotations humans actually cited in settlement are the relevance labels. Score scout findings on evidence recall and citation validity **against `search.everything`'s own top-6** for the same question text, reported per-question. The candidate-count asymmetry (scout sees ≤40, search returns 6) is reported alongside, not hidden: the claim being tested is "the scout beats what ⌘K would have shown you," which is the user-visible baseline.

GroupMemBench's lesson stands: if the scout doesn't beat the search drawer, it doesn't ship.

## 11. Risks

- **Thin findings erode trust faster than no feature** → citation gates, honest nulls, launch gate (§10.2).
- **A second model surface** → shared `lib/citations/` extraction; one gate implementation.
- **Brief latency** → scout strictly after brief write; brief never blocks.
- **Cost** → one call per brief batch, rolling daily budget, retrieval caps.
- **Scope creep toward chat** → the subject fence: no open question, no scout.

## 12. Build plan

> Scheduled as Track C (C1–C5) in `docs/TIMELINE.md`, which owns sequencing relative to the other tracks.

1. **PR A — substrate:** tables, ledger events, lifecycle cascade (+ `actions.ts` comment correction), claim/lease/expiry, caps, stub-agent run path, CI invariant tests.
2. **PR B — eval:** ledger-ground-truth harness + baseline comparison; report format.
3. **PR C — scout:** `lib/citations/` extraction (synthesis refactored to share it), gather in scheduled-reader mode + guard test, model call, sanitizer, failure states.
4. **PR D — surfaces:** brief section, outcomes chips, finding card, settle-with-finding.

## 13. Review log (what the red-team changed)

1. **Trigger:** button → brief-embedded (Opus KILL-adjacent #8; also fixed strategy-fidelity overclaim).
2. **Notifications: cut from v1 entirely.** Both reviewers independently showed the planned reuse notified nobody (self-notify refusal; question actions can't have owners) and the "minimal" widening broke the dedupe index and five downstream call sites. The brief *is* the delivery surface; v1.5 uses reactive card status. If notifications ever return, they get a subject-discriminated path and their own index — designed then, not now.
3. **Cut as unverifiable or gold-plating:** `status_note` item kind (statuses render mechanically from live rows), model-written `searchedSummary` (now computed `coverage`), per-viewer dismissal state, v1.5+ literature scout details.
4. **Authz honesty:** "reuse the synthesis harness" → the named scheduled-reader mode (§3.6); public gates (`search.everything`, synthesis lease mutations) are not reachable from a scheduled action and are no longer claimed.
5. **Redaction:** any-citation-survives → **whole-item redaction** (Sol KILL).
6. **Lifecycle:** lease expiry timestamps, atomic claim, store-time re-validation, cancel-clears-lease, settle/remove/withdraw cascade, tombstoned history, no-model-call-on-retry (both reviewers).
7. **Caps:** `by_lab_and_status` index, daily run budget, per-requester fairness (Sol).
8. **Prompt safety:** JSON serialization instead of `fence()` tag-stripping (Sol).
9. **Adoption affordances:** citations-only prefill; subject-specific action sets; `findingId` provenance on settlement (both reviewers).
10. **Eval:** split into CI invariants + ledger-ground-truth launch gate (Opus).
