# Margin — Execution Timeline

**Updated:** 2026-08-18 (Track P folded in; Waves 1–4 all shipped) · against `origin/main` @ `012a0c9`
**This is the single source of truth for execution order.** The other docs stay as rationale and design — when sequencing here disagrees with a roadmap section elsewhere, this file wins and the other doc should be corrected.

| Source doc | Role |
|---|---|
| `docs/STRATEGY.md` | Why: moat, ICP, adoption playbook, competitive/prior-art evidence, phase rationale |
| `docs/design/agent-delegation.md` | Design for Track C (the scout), post red-team v2 |
| UX-polish plan (Track A below — previously a standalone plan) | Screen-level fidelity + README-gap closure, folded in here |
| `docs/PLG.md` | Why and what for Track P: the product-led funnel (evidence + the P1–P7 build list) |
| `docs/X-FACTOR.md` | Who pays and what's fundable; composes with PLG (proposed Track E — no go decision yet) |

**House rules for every dispatched task** (from the standing project workflow):
- Feature branch → small commits → PR → Greptile + Opus review → merge only when green. Never push to main.
- Every worker prompt: goal, file allowlist, non-goals, stop condition. Change only listed files; flag adjacent issues, don't fix them.
- UI tasks load the design skills (`frontend-design`, `web-design-guidelines`); verify in a real browser where feasible.
- No pricing/monetization content anywhere in product or site.
- Parallel tasks run in separate worktrees; check the conflict map (§5) first.

Status legend: `[ ]` todo · `[~]` in flight · `[x]` shipped (PR#).

---

## 1. Track A — UX polish & README fidelity (in flight, this branch's lineage)

Sequential; each PR polishes a screen *and* closes that screen's README-fidelity gaps.

- [x] **A1 — Reader (flagship).** (#72) Anchored margin rail (vertical alignment to passage, minimal-displacement collision relax, hover linking note↔highlight with type-colored connector), composer flip/shift + persistent selection + ⌘↵, reserved filter-chip height, higher highlight alpha, zoom/fit-width/page jump, fix Tab walking 37 unlabeled page containers; carries foundation leftovers (legacy 200ms/`scale-[0.96]` press grammar at 3 call sites, composer Escape-eats-draft bug, `Popover` controlled open/anchor).
  **⚠ Pre-task: re-audit the reader against fresh main before writing the plan.** Since the original audit, the rail gained ~900 lines: `reactions.tsx` (171), `mention-field.tsx` (265), `annotation-history.tsx` (173), `epistemic-status.tsx` (306), plus card/composer edits. The relax layout must handle variable/expanding card heights; composer positioning now interacts with mention autocomplete; Escape must close the mention menu before touching the draft.
- [x] **A2 — Sessions.** (#73) Start-session disabled outside window with inline hint (kills the "isn't until in about 25 hours" server-error phrasing); End/Cancel confirm + undo toast (first real consumer of the toast layer); board quotes trimmed to sentence boundaries with `[nn]` debris stripped; legible type-distribution bar; **stable per-note synthesis citation numbering** (today every one renders "Note 1"); session↔reader loop via "← Back to session".
  ⚠ #55 (outcomes) touched the session board — verify quote-trimming targets still match before planning.
- [x] **A3 — Library / ingest.** (#75) Post-ingest triple-title collapsed; `Done adding` and `Record` read as controls; upload byte progress with a cancel that works — verified cross-origin against the dev deployment; DOI/reference import with stops that hold at every seam (panel holds carry their exit's name); disabled dropzone refuses drops at the browser level.
- [x] **A4 — Shell & theme.** Theme toggle (auto/light/dark, default dark) replacing the wall-clock switch — a blocking boot script decides the class before first paint, the rail's footer carries the three-word radiogroup, and the forced-dark reader dims its PDF sheet whatever the OS asked for; digest placement fixed (the inbox holds its slot until both late paths answer, and a session's empty prep ghost folds shut instead of dropping out mid-page); all four README product figures reshot from the shipped dark default.

## 2. Track B — Remaining table stakes (strategy Phases 0–1 leftovers)

Independent of each other; parallelizable. All small-to-medium.

- [x] **B1 — Google OAuth** (#64) (magic links shipped in #45).
- [x] **B2 — Email delivery finished** (#65) (retry with idempotency key, paced fan-out, guard tests enforcing the constitution; operator steps in the PR body).
- [x] **B3 — Slack delivery** (#69) for briefs, digests, synthesis write-ups (webhook-level, not an app; the write-up is the distribution artifact — treat formatting as first-class).
- [x] **B4 — Session-agenda templates.** (#70)
- [x] **B5 — Native Zotero sync.** (#77) Link with an API key, pick a scope, and the shelf follows: hourly one-page walk with a durable resumable cursor (`lastVersion` moves only on completion), Sync now, DOI-deduped items with PDFs. `syncPayload` is the one guard-tested key carrier; `commitPage` is fenced by a `(start, lastVersion, generation)` compare-and-set; a walk restarts only when its result set shrinks, re-baselined so it then advances. (Import shipped via BibTeX/RIS in #47.)

## 3. Track C — The scout (agent delegation) + eval

Design: `docs/design/agent-delegation.md` (v2). Sequential; C2 blocks C3's *launch*, not its development.

- [x] **C1 — Substrate.** (#66) `delegations` + `findings` tables, ledger events, lifecycle cascade (settle/remove/withdraw cancels active delegations; correct the now-false `actions.ts` "nothing builds on outcomes" comment), atomic claim + lease expiry, caps (`by_lab_and_status`, daily budget), stub-agent run path, **CI privacy invariants** (no private row can reach a prompt/finding; whole-item redaction; label gates).
- [x] **C2 — Eval harness.** (#68) Ledger-ground-truth: for historically settled questions, the annotations humans cited in settlement are the relevance labels; score scout output vs `search.everything` top-6. Reported per-question; candidate-count asymmetry disclosed. *(This is also the last open box of strategy Phase 2 — one item, not two.)* Run on dev returns n=0 scoreable questions — the gate stays closed until a corpus with settled, cited questions exists, and `actions` needs a `by_lab_and_settled` index before a verdict at scale.
- [x] **C3 — Scout run.** (#76) Citation gates extracted into `lib/citations/` (one redaction authority across gather, read, store, and synthesis); scheduled-reader gather + guard tests; model call (JSON-serialized untrusted context, strict schema, no retry of the model call); sanitizer; failure states — verified end-to-end against the dev deployment: queued→returned with per-item citations, whole-item redaction on privatized notes, `model-unavailable` without a key.
  Landed on `kgarg2468/c3-scout`: the shared gates, the scheduled-reader gather (search + the brief row as the collision source, per §6.3), one model call per brief's batch under one label space (§6.4), and the two call sites that make any of it run — `briefs.buildForSession` schedules the enqueue after the brief, and `annotations.setVisibility`/`remove` cancel through `cascadeForAnnotation`. Not landed: no surface consumes it (C4 owns every pixel), the brief's collision lines still get one of the two prompt gates rather than both, and **the launch gate stays shut** — C2 has yet to show the scout beating the search drawer.
- [x] **C4 — Surfaces.** (#79) The marker grammar closes where C3 opened it: `[A#]` is a wire format, stripped at the surface, and what a reader sees under an item is an author and a page that links into the reader — or a count of what this page has no row for, never a link it cannot aim. The brief grows a violet-ruled **Scout** block beneath each carried-forward question, on its own subscription: the agenda paints first and the block arrives when it arrives, a run in flight is one quiet line that resolves itself without a reload, and an empty or failed run says so in the failure vocabulary rather than leaving a standing report looking stale. The outcomes panel gets the same card plus a per-row status chip, and *Settle with this* stores `findingId` provenance on the settlement so the ledger records what informed it. *Adopt citations* opens the reader at the question with the composer holding author/page/quote lines and a blank line above them — citations only, never model prose. Walked end to end against dev: returned, empty, and `model-unavailable`; a run watched `queued → returned` live with the brief row untouched; whole-item redaction landing within a second of a cited note going private; and an adopted reply dropping its question from the next assembly.
- [x] **C5 — Brief consumes cross-paper collisions.** (#79, rode along) `lib/brief/assemble.ts` no longer stops at the paper boundary: a normalized claim key pairs notes across the lab's corpus, gated on a gold pair of epistemic types, two different members, and a quote long enough to be a real overlap — and the collisions section carries a line naming **both** documents, ranked below every same-paper line, its citations rendered as plain "Note N" because the far paper's reader is not an address this row carries yet. The lift is for collisions only; carry-forward of *outcomes* stays per-paper, which is what this box scoped.
  **The launch gate stays shut.** Both boxes ship the build, not the launch: C2 still reports n=0 scoreable questions on dev, so the scout has not been shown to beat the search drawer and none of this goes to design partners until it has.

Gate: **C3/C4/C5 do not launch to design partners until C2 shows the scout beating the search drawer.**

## 3b. Track P — PLG core (go decision 2026-08-18; design + evidence in `docs/PLG.md`)

The ladder: see it without an account → useful alone in three actions → second person costs one click → the ritual. Everything below is small-to-medium; P1/P3/P4 are independent of all other tracks.

- [ ] **P1 — Solo entry.** Auto-provision a personal library at signup (an invisible one-member lab — the model already supports it); land new users in the library with the add-paper panel open, not on organizational setup; jump straight into the reader after ingest. Eight actions become three.
- [ ] **P2 — Read-only share links.** Annotated paper + signed-off synthesis, opt-in per artifact, unlisted URLs, revocation-on-read, only lab-visible annotations ever render. The viral loop; the first public surface. Sequence after P1; touches auth/visibility surfaces — coordinate via the conflict map.
- [ ] **P3 — Solo catch-up mode.** The digest currently excludes your own notes ("colleagues wrote things while you were away"); in a one-member lab, your past self is the colleague — "you flagged this same assay in March." The thesis delivered to a single user.
- [ ] **P4 — Seeded demo paper.** Every new library opens containing one classic annotated paper so the first screen demonstrates the margin-conversation idea instead of showing a form.
- [ ] **P5 — Quiet lab conversion + guest tier.** Invite-from-personal-library names/converts the lab; a viewer/guest state on shared artifacts (membership roles are exactly `pi|member` today — deliberate schema change, needs design). After P2.
- [ ] **P6 — Projected-board polish.** Rides Track A (A2 shipped #73); the weekly 10-person demo is the 39% discovery channel. No new box — fold future board work here.
- [ ] **P7 — Share-link → signup → annotate continuity.** Closes rung 0 into rung 1. After P2.

Ordering: **P1+P4 first (one PR), P3 alongside (own PR), then P2 → P5/P7.** Monetization stays out of the product entirely (standing rule); nothing in Track P adds pricing surfaces.

## 3c. Track V — Signature visual layer (founder direction 2026-08-18)

Direction from Krish: use three.js for front-end animation; scan effects over cards; wireframe treatments in the spirit of Death Stranding's terrain-scan sweep.

- [ ] **V1 — Scan-effect spike.** One shared WebGL surface (never per-card contexts), a wireframe/scan sweep grammar that respects `prefers-reduced-motion` and never regresses the 120Hz compositor-only press feel; applied first where it earns its bytes (landing hero, card reveal/hover sweep). Ships as its own PR with screenshots/recordings for founder judgment before any wider rollout.
- [ ] **V2 — Rollout.** Apply the approved grammar across card surfaces (library, scout findings, session board). Gated on V1 approval.

## 4. Track D — Later (strategy Phase 3; do not start without a new decision)

In rough order: on-demand delegation (scout v1.5, reactive card status — no notifications until a subject-discriminated notification path is designed) · AI-*suggested* epistemic edges (proposal slot already reserved in schema; always human-assented) · new-member onboarding paths · paper-triage-on-add · browser capture extension · public API / MCP server (contract shape already fixed by C1's mutations) · literature scout (external retrieval; separate design doc required) · audio overview of the weekly synthesis · optional exploration view over the derived index.

Non-engineering, founder-owned, runs alongside everything: recruit 5–10 design-partner labs (life-science/clinical, existing weekly cadence, 5–15 people); white-glove onboarding (import their last month of papers); track the north-star metric — **consecutive weekly sessions per lab** (8+ = converted, two skips = churning) and % of members annotating before each session.

## 5. Conflict map (for parallel dispatch)

| Files / area | Tracks touching it | Rule |
|---|---|---|
| `convex/schema.ts` | C1 (new tables), B1 (verify-only), anything adding a table | C1 owns Wave-1 schema changes; later schema edits rebase onto C1's |
| Reader components (`read/_components/*`) | A1 only | Nothing else touches the reader until A1 merges |
| Session page + board + synthesis display | A2, C4, C5 | A2 first; C4/C5 after A2 merges |
| `convex/synthesis.ts` (server) | C3 (lib/citations extraction) | Independent of A2's display work, but coordinate if concurrent |
| `convex/actions.ts`, outcomes panel | C1 (cascade + comment), C4 (chips) | C1 before C4 |
| `convex/briefs.ts`, brief UI | A2 (citation numbering also lives in `brief.tsx`), B3 (delivery formatting), C4, C5 | A2/B3 are in earlier waves so no live collision; C4/C5 either order, prefer same worktree |
| Auth (`convex/auth.ts`) | B1 | Isolated |
| Notifications/email | B2 | Isolated (Track C deliberately does not touch notifications) |
| Library/ingest UI | A3 | Isolated |
| Shell/theme/README assets | A4 | Isolated; A4 last in Track A so screenshots capture A1–A3 |

| Signup/onboarding flow (`convex/labs.ts`, `convex/users.ts`, post-auth routing) | P1, P5 | P1 owns the auto-provision path; P5 rebases onto it |
| Digest assembly (`convex/digests.ts`) | P3 | Isolated from P1/P4 |
| Landing page + card surfaces (visual layer) | V1, V2 | V1 spike approved before V2 touches shared card components |

**Suggested parallel waves** (each item = one worker in its own worktree):
- **Wave 1:** A1 (big, Opus) ∥ B1 ∥ B2 ∥ C1 — shipped
- **Wave 2:** A2 ∥ B3 ∥ C2 ∥ B4 — shipped
- **Wave 3:** A3 ∥ C3 ∥ B5 — shipped
- **Wave 4:** A4 ∥ C4+C5 → design-partner launch gate (C2 results) → Track D decision — shipped; gate still shut (C2 n=0)
- **Wave 5 (now):** P1+P4 ∥ P3 ∥ V1 → founder review of V1 → P2 → P5/P7 ∥ V2

## 6. Done (context for agents — don't rebuild these)

The bulk of strategy Phases 0–2 shipped as PRs #41–#62 (Track B above is what remains), including: magic links (#45), gated PDFs (#42), ⌘K search (#44), synthesis sign-off (#43), export (#48), BibTeX/RIS import (#47), mentions (#52), reactions (#51), tags/collections (#54), calendar (#50), since-you-were-away (#49), presenter brief (#53), outcomes (#55), cross-paper digest collisions (#56), annotation edit history (#57), cross-page anchoring (#58), temporal memory (#59), epistemic status (#60), interaction layer (#61), auth/deploy fixes (#62), this timeline (#63), Google OAuth (#64), email delivery (#65), scout substrate (#66), scout eval harness (#68), Slack delivery (#69), session-agenda templates (#70). Rationale: `docs/STRATEGY.md` §9 (its §2 capability table is a pre-#41 snapshot — read §9 for current state).
