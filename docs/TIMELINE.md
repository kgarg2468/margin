# Margin — Execution Timeline

**Updated:** 2026-08-09 (Wave 1 lands) · against `origin/main` @ `ad2a9b1`
**This is the single source of truth for execution order.** The other docs stay as rationale and design — when sequencing here disagrees with a roadmap section elsewhere, this file wins and the other doc should be corrected.

| Source doc | Role |
|---|---|
| `docs/STRATEGY.md` | Why: moat, ICP, adoption playbook, competitive/prior-art evidence, phase rationale |
| `docs/design/agent-delegation.md` | Design for Track C (the scout), post red-team v2 |
| UX-polish plan (Track A below — previously a standalone plan) | Screen-level fidelity + README-gap closure, folded in here |

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

- [~] **A1 — Reader (flagship).** Anchored margin rail (vertical alignment to passage, minimal-displacement collision relax, hover linking note↔highlight with type-colored connector), composer flip/shift + persistent selection + ⌘↵, reserved filter-chip height, higher highlight alpha, zoom/fit-width/page jump, fix Tab walking 37 unlabeled page containers; carries foundation leftovers (legacy 200ms/`scale-[0.96]` press grammar at 3 call sites, composer Escape-eats-draft bug, `Popover` controlled open/anchor).
  **⚠ Pre-task: re-audit the reader against fresh main before writing the plan.** Since the original audit, the rail gained ~900 lines: `reactions.tsx` (171), `mention-field.tsx` (265), `annotation-history.tsx` (173), `epistemic-status.tsx` (306), plus card/composer edits. The relax layout must handle variable/expanding card heights; composer positioning now interacts with mention autocomplete; Escape must close the mention menu before touching the draft.
- [ ] **A2 — Sessions.** Start-session disabled outside window with inline hint (kills the "isn't until in about 25 hours" server-error phrasing); End/Cancel confirm + undo toast (first real consumer of the toast layer); board quotes trimmed to sentence boundaries with `[nn]` debris stripped; legible type-distribution bar; **stable per-note synthesis citation numbering** (today every one renders "Note 1"); session↔reader loop via "← Back to session".
  ⚠ #55 (outcomes) touched the session board — verify quote-trimming targets still match before planning.
- [ ] **A3 — Library / ingest.** Collapse post-ingest triple-title; make `Done adding` and `Record` look like controls; upload byte progress with cancel.
- [ ] **A4 — Shell & theme.** Theme toggle (auto/light/dark, default dark) replacing the wall-clock switch; digest placement fixed (nothing pops in mid-page); README screenshot regeneration to match shipped reality.

## 2. Track B — Remaining table stakes (strategy Phases 0–1 leftovers)

Independent of each other; parallelizable. All small-to-medium.

- [x] **B1 — Google OAuth** (#64) (magic links shipped in #45).
- [x] **B2 — Email delivery finished** (#65) (retry with idempotency key, paced fan-out, guard tests enforcing the constitution; operator steps in the PR body).
- [x] **B3 — Slack delivery** (#69) for briefs, digests, synthesis write-ups (webhook-level, not an app; the write-up is the distribution artifact — treat formatting as first-class).
- [x] **B4 — Session-agenda templates.** (#70)
- [ ] **B5 — Native Zotero sync** (import shipped via BibTeX/RIS in #47; this is the live-sync upgrade — lower priority than B1–B3).

## 3. Track C — The scout (agent delegation) + eval

Design: `docs/design/agent-delegation.md` (v2). Sequential; C2 blocks C3's *launch*, not its development.

- [x] **C1 — Substrate.** (#66) `delegations` + `findings` tables, ledger events, lifecycle cascade (settle/remove/withdraw cancels active delegations; correct the now-false `actions.ts` "nothing builds on outcomes" comment), atomic claim + lease expiry, caps (`by_lab_and_status`, daily budget), stub-agent run path, **CI privacy invariants** (no private row can reach a prompt/finding; whole-item redaction; label gates).
- [x] **C2 — Eval harness.** (#68) Ledger-ground-truth: for historically settled questions, the annotations humans cited in settlement are the relevance labels; score scout output vs `search.everything` top-6. Reported per-question; candidate-count asymmetry disclosed. *(This is also the last open box of strategy Phase 2 — one item, not two.)* Run on dev returns n=0 scoreable questions — the gate stays closed until a corpus with settled, cited questions exists, and `actions` needs a `by_lab_and_settled` index before a verdict at scale.
- [ ] **C3 — Scout run.** Extract citation gates from synthesis into `lib/citations/` (synthesis refactored to consume it), scheduled-reader gather + guard test, model call (JSON-serialized untrusted context, strict schema, no-retry-of-model-call), sanitizer, failure states.
- [ ] **C4 — Surfaces.** Brief section (findings under carried-forward questions, reactive, never blocking the brief), outcomes-panel status chips, finding card (*Settle with this* + citations-only adopt), `findingId` provenance on settlement.
- [ ] **C5 — Brief consumes cross-paper collisions.** `lib/brief/assemble.ts` still stops at the paper boundary even though #56 lifted it in the digest — wiring it through is the cheapest "the product remembered something" unlock. Small PR; can land any time after A2 (both touch session surfaces) and pairs naturally with C4.

Gate: **C3/C4 do not launch to design partners until C2 shows the scout beating the search drawer.**

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

**Suggested parallel waves** (each item = one worker in its own worktree):
- **Wave 1 (now):** A1 (big, Opus) ∥ B1 ∥ B2 ∥ C1
- **Wave 2:** A2 ∥ B3 ∥ C2 ∥ B4
- **Wave 3:** A3 ∥ C3 ∥ B5
- **Wave 4:** A4 ∥ C4+C5 → design-partner launch gate (C2 results) → Track D decision

## 6. Done (context for agents — don't rebuild these)

The bulk of strategy Phases 0–2 shipped as PRs #41–#62 (Track B above is what remains), including: magic links (#45), gated PDFs (#42), ⌘K search (#44), synthesis sign-off (#43), export (#48), BibTeX/RIS import (#47), mentions (#52), reactions (#51), tags/collections (#54), calendar (#50), since-you-were-away (#49), presenter brief (#53), outcomes (#55), cross-paper digest collisions (#56), annotation edit history (#57), cross-page anchoring (#58), temporal memory (#59), epistemic status (#60), interaction layer (#61), auth/deploy fixes (#62), this timeline (#63), Google OAuth (#64), email delivery (#65), scout substrate (#66), scout eval harness (#68), Slack delivery (#69), session-agenda templates (#70). Rationale: `docs/STRATEGY.md` §9 (its §2 capability table is a pre-#41 snapshot — read §9 for current state).
