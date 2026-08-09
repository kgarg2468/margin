# Margin — Strategy Report & Roadmap

**Date:** 2026-08-08
**Method:** Synthesis of two independent agent strategy audits, an adversarial two-round debate between opposing agents, a repository fact-check, an independent GPT referee pass, and two deep-research lanes (product landscape + academic literature, all citations verified).

---

## 1. Executive summary

Margin's window is real but narrow. No shipping product and no published system today offers what Margin is positioned to build: a **group-level, passage-grounded, temporally-evolving memory of how a research lab reasons about literature**. The market splits cleanly into (a) group annotation without memory (Scholars.io, Hypothesis, Perusall) and (b) literature AI without groups (Elicit, NotebookLM, OpenScholar, FutureHouse). Nobody joins them. The academic field is arriving at the same idea (CHOIR, CHI 2026; the governed-shared-memory line), so the realistic head start is **12–24 months**.

The strategy in one paragraph: **win the journal-club ritual, ship the familiar core features that make switching a no-brainer, and let the memory layer accumulate as exhaust.** The moat is not an architecture (anyone at a big lab can replicate the design in a quarter) — it is being the product that already holds a year of a lab's reasoning when the copies arrive. Speed to accumulated data is the moat, and this team's shipping speed is therefore itself a strategic asset.

Positioning line:

> **Margin remembers why your lab believes what it believes — and can trace every conclusion back to the person, passage, and discussion that produced it.**

---

## 2. What Margin is today (repo-verified, commit `6048ec2`)

> **Point-in-time snapshot.** This table was verified against commit `6048ec2`, before PRs #41–#62 landed. For what has shipped since, read §9 and `docs/TIMELINE.md` §6 — do not treat the ❌/🚧 rows below as current.

| Status | Capability |
|---|---|
| ✅ Shipped | Labs, memberships, invites; DOI/PDF ingestion with open-access copy discovery |
| ✅ Shipped | PDF reader (light/dark), typed passage-anchored annotations, private/lab visibility, threaded replies |
| ✅ Shipped | Session lifecycle (scheduled → live → ended → synthesized), presenter notes, live passage board |
| ✅ Shipped | Deterministic prep digests + typed cross-member "collisions" |
| ✅ Shipped | AI synthesis with attribution *derived* from source annotation IDs; withdrawn/private material re-checked on every read |
| ✅ Shipped | Append-only event ledger; CI-enforced no-read-tracking privacy constitution |
| ⚠️ Partial | "Since you were away" digests — schema + UI exist, no producer writes them |
| ⚠️ Partial | Synthesis approval — `sessions.synthesis` / `synthesisApprovedAt` fields exist, nothing writes them |
| ❌ Missing | Any search (zero `searchIndex`/`vectorIndex` in schema; no search UI) |
| ❌ Missing | Cross-paper intelligence — collision engine hard-stops at paper boundary (`lib/digest/engine.ts:160`) |
| ❌ Missing | Annotation history — edits overwrite in place; ledger's `annotation.edited` stores no prior body |
| ❌ Missing | OAuth/magic-link auth (password only), Zotero/BibTeX/RIS import, any export, collections/tags, notifications/mentions, Slack/calendar/email delivery, browser extension, mobile, API |
| 🔒 Known issue | PDF URLs are permanent unauthenticated storage links (issue #9) |

**Two factual corrections to earlier internal claims:**
- Anchoring is **page-pinned**: re-anchoring is robust *within* a page, but a repaginated PDF (e.g., arXiv v1→v4) drops notes to "unanchored" cards rather than re-finding them. Don't market "survives PDF variants" until cross-page recovery exists.
- "Ground-truth read-sets" is **not** an available asset — the privacy constitution bans read/dwell tracking (CI schema guard). The usable signal is *written* annotations only. This is a strength (anti-surveillance stance), but positioning must reflect it.

---

## 3. The moat — final verdict from the debate

**Substrate is the moat; activation is the roadmap.** Every roadmap item should pass a joint test: *which recurring workflow re-activates it, and which provenance property does it preserve?*

### 3.1 The novel primitive Margin already ships

Margin's synthesis treats every AI-generated claim as a **revocable derivation of live source rows**: attribution is mechanically derived from resolved citation IDs (not trusted to the model), items whose claimed author isn't among the cited annotations are dropped, and `isStillShared` + `applyWithdrawals` re-check every citation *on read* — withdraw a note and the paraphrase built from it is replaced, not merely unlinked (`convex/synthesis.ts`). **No memory vendor does this.** Mem0, Zep/Graphiti, and Letta all treat extracted facts as durable rows that outlive their sources. This is the differentiated foundation to extend — not a knowledge graph bolted alongside it.

### 3.2 The memory bet, sequenced (satisfies the novel-tech mandate)

Two distinct axes, both required:
- **Revocability** — "may I still show this?" (shipped, above)
- **Epistemic status** — "did the lab change its mind?" (missing: today a withdrawn note and a superseded position vanish identically)

1. **Event-source annotation edits** (small schema change, do first). Today `updateBody`/`setType` overwrite in place and the ledger records no prior body — the substrate silently loses every prior belief state, so nothing can answer "what did we think in March and what superseded it." Store prior body/type in the `annotation.edited`/type-change ledger events. This makes the substrate genuinely **bitemporal** and doubles as user-facing *version history* (a Notion/Docs parity feature — see §6).
2. **Epistemic-status typing as a projection** over that history: `proposed / accepted / disputed / resolved / superseded` + effective dates, per-edge authorship and visibility. Human-authored transitions first; AI-*suggested* transitions only later, always requiring acceptance.
3. **A temporal derived index** for the query classes context-stuffing can't serve ("what survived three sessions," "who flipped position," "what's still unresolved" — absence-of-resolution is not a text span). Built as Convex indexes/projections. **Never marketed as a knowledge graph** — graph retrieval's benchmark gains largely evaporate under unbiased evaluation (Mem0's graph variant: ~2pp; GraphRAG gains "much more moderate" under unbiased evals).

Why not context-stuffing: a realistic lab-year is ~1M tokens once page text and presenter notes are counted (the code's own synthesis cap is 400 annotations — one session's worth); aggregation/temporal queries aren't needle retrieval; and per-read visibility rechecks invalidate any prefix-cached corpus blob, so stuffing is economically wrong at every scale.

**Highest-leverage single line in the repo:** `lib/digest/engine.ts:160` — `if (a.paperId !== b.paperId) return null;`. Lifting the cross-paper collision boundary turns a per-meeting digest into lab memory.

---

## 4. Competitive landscape

### 4.1 Direct-shape threats (verified, ranked)

| # | Threat | What they have | Their gap (Margin's opening) | Severity |
|---|---|---|---|---|
| 1 | **NotebookLM** | Free, Google distribution; shared notebooks (Viewer/Editor, bulk email share); cross-session memory; multi-format ingestion; audio overviews | Memory is **notebook-siloed** (can't answer across notebooks); grounding is document-level; human annotation isn't a first-class object; no passage anchoring or typing | High |
| 2 | **Scholars.io** | Free shared "reading rooms," real-time passage annotation on PDFs, threads, private groups | AI grounds in *the paper*, not the group's reasoning; untyped comments; no cross-paper memory; stops exactly where Margin starts | High |
| 3 | **Foreground** | Owns the *medical residency* journal-club ritual: PubMed surveillance, club workspace, scheduling, appraisal coaching, ACGME sign-off, "Ask Corpus" cited answers | AI grounds in the literature corpus, not what the club argued; residency-specific | Med-High |
| 4 | **Hypothesis** | The installed base for group annotation (LMS-provisioned groups, PDFs/web/JSTOR) | Explicitly **anti-AI** positioning; no memory layer; structurally unlikely to build one | Medium |
| 5 | **Elicit / Edison, OpenScholar, PaperQA2** | Capital + model quality in literature QA/discovery | Single-user, stateless over public corpora; no group state | Medium |
| 6 | **Agent-memory vendors** (Mem0 $24M, Zep, Letta) | Infrastructure with team access-control | Infrastructure, not product; nobody has applied it to research literature | Medium |
| 7 | **Heureka Bench** | Papers + annotations + knowledge graph, desktop | Local-first, single-scientist by construction | Low |

Note: "Joey ELM" and "NextELN," cited in one earlier memo, could not be verified to exist — discard.

### 4.2 The Greptile lesson

Greptile's codebase memory works because code has **deterministic, machine-recoverable structure** (AST → call graphs → embeddings), and its accumulated team-preference learning is an explicit switching cost ($30M raised, 9k+ teams). Literature has no AST. The analogy transfers only if the structure is *manufactured* — and Margin's typed annotation ontology + W3C anchors is exactly that substitute AST, **human-supplied where the compiler would be**. That's why annotations must stay effortless (one tap to type, empty body allowed): the structure must be a byproduct of reading together, never a curation task.

### 4.3 What the research literature says (all citations verified)

- **The problem is open.** No published system tracks a specific group's evolving, attributed beliefs about literature with passage provenance. Closest: **CHOIR** (arXiv:2509.20512, CHI 2026 Best Paper HM) — lab organizational-memory chatbot, 4-lab deployment — but procedural memory, no claim-status or provenance model.
- **The group setting is genuinely unsolved.** GroupMemBench (arXiv:2605.14498): best memory system 46% average; knowledge-update (exactly "the lab accepted this, then superseded it") worst at 27%; plain BM25 beats most agent-memory systems. *BM25 is the bar to clear — build the retrieval baseline and evaluate against it.*
- **Engineering spec for free:** Governed Shared Memory (arXiv:2606.24535) names the four failure modes Margin must survive: unauthorized leakage, stale propagation, contradiction persistence, provenance collapse.
- **The 20-year warning:** nanopublications, micropublications, and ORKG all offer structured claims with provenance; scientists never adopted them (ORKG pays curators and still averages ~2 annotations/paper). **Structuring must be a byproduct of journal club, never a task.**
- **The self-report mirage:** transactive-memory meta-analysis (Small Group Research, 2026): self-reported benefit r=.77 vs objective r=.39. Labs will *say* Margin helps regardless — only behavioral retention counts.

---

## 5. Ideal customer profile

> **A 5–15 person academic life-science or clinical-translational research lab with an existing weekly/biweekly journal club, a rotating presenter, regular trainee turnover, and notes fragmented across Zotero/Paperpile, Google Docs, and Slack.**

- **Cadence is the real qualifier** — an existing recurring meeting matters more than headcount. No hard floor; a 5-person lab with a sacred weekly slot beats a 12-person lab without one.
- **Life-science/clinical is both messaging and a technical heuristic**: version-of-record PDFs hold Margin's page-pinned anchors; preprint-churn fields (arXiv CS/ML) silently break re-anchoring until cross-page recovery ships.
- **Champion:** senior PhD student, postdoc, or lab manager who organizes the club. **Buyer (later):** PI. **Daily users:** the whole lab.
- **Avoid initially:** solo researchers, undergraduate courses (Perusall/Hypothesis own distribution), systematic-review teams (Covidence/Rayyan), regulated pharma (procurement-dominated), labs without recurring group reading.

---

## 6. The no-brainer switch: core-feature parity matrix

The founder's thesis, adopted here: users won't leave the tools they're hooked on unless the familiar primitives are present. The team ships fast enough that parity on *primitives* is affordable. The discipline: parity on **interaction primitives**, not on *product categories* (build comments; don't build a block-editor workspace).

### 6.1 What keeps people hooked, tool by tool → Margin's move

| Incumbent | Hook features their users expect | Margin's move |
|---|---|---|
| **Google Docs** | Real-time cursors/presence; comments + @mentions + **assigned tasks**; suggestion mode; version history with named versions; offline; export to every format; share links with granular permissions | **Build native:** presence in the reader + live session board (partly shipped), comments/threads (shipped), @mentions + notifications, assigned action items, version history (falls out of §3.2 event-sourcing), export (MD/DOCX/PDF/HTML), granular share links. **Skip:** general document editing — export *into* Docs instead |
| **Notion** | ⌘K quick-find; slash commands; templates; databases/views/filters; synced blocks; web clipper; import-from-everything; AI in-context; dark mode; keyboard-first UX | **Build native:** ⌘K global search-and-jump (papers, annotations, people, sessions — this is also the missing search layer), collections/tags/saved filters, session-agenda templates, keyboard shortcuts throughout, one-click import (DOI/PDF/arXiv/PubMed link paste — partly shipped), dark mode (shipped). **Skip:** databases, block editor, general workspace ambitions |
| **Zotero / Paperpile** | One-click browser capture; group libraries; collections + tags + saved searches; citation styles + Word/Docs plugins; BibTeX/RIS everything; dedup; PDF sync | **Integrate + import:** Zotero/BibTeX/RIS import (P0), cite-key + BibTeX export, browser capture extension (P1). **Don't rebuild** citation management — "Keep Zotero" is the pitch |
| **Slack** | Notifications where people already live; threads; reminders | **Integrate:** digest/synthesis/reminder delivery into Slack + email; never try to move lab chat |
| **Google Calendar / Zoom** | The meeting itself | **Integrate:** .ics/calendar events for sessions, meeting-link field. Never rebuild |
| **Perusall / Hypothesis** | Upvotes/reactions; assignment flows; anonymous modes | **Selective:** lightweight reactions on annotations (cheap social glue). Skip grading/assignment machinery |
| **NotebookLM** | Multi-format ingestion; cited answers; audio overviews | **Match where on-thesis:** cited "Ask" *inside* the brief (§7); audio overview of the weekly synthesis is a cheap, delightful differentiator candidate (post-P1) |

### 6.2 Trust features that unblock switching (from both original audits, confirmed)

- Google OAuth **and** magic-link invites — a member's first entry must be: click link → reading the paper. No password ceremony.
- Membership-gated PDF delivery (fix issue #9 — permanent unauthenticated URLs).
- **Full export always** (papers, annotations, sessions, syntheses → MD/CSV/BibTeX/JSON): "you can leave anytime with everything." Weakens lock-in, wins adoption; right trade at this stage.
- Human edit/approve for synthesis (fields exist; wire them + a simple editor). AI output a lab circulates must be *theirs*.
- Visible data controls: deletion, retention, model-processing disclosure. The no-surveillance constitution is a marketing asset — say it loudly.

---

## 7. The adoption playbook

Memory products deliver nothing on day 1 and compound on day 60, while adoption is decided in week 1. Every choice below attacks that asymmetry.

1. **The presenter is the hero — single-player value first.** One organizer, alone on a Sunday night, must get value before anyone else joins: paste DOI → great reader → pre-session brief generated. Prep drops from hours to minutes. The lab joining is step two and costs members one click.
2. **The post-meeting artifact is the distribution engine.** The cited, human-approved synthesis that lands in Slack/email is seen by every member — including those who never opened Margin — and by neighboring labs when it's forwarded. Make it beautiful, cited, exportable, never gated. It is simultaneously the value proof and the viral loop (postdocs change labs; journal clubs are visible across departments).
3. **The memory reveals itself; it is never the pitch.** Week 1's brief: "here's the paper." Week 6's brief: "Sara challenged this same assay on March 12 — here's her note." That moment, inside the ritual, is when Margin becomes irreplaceable. Requires: cross-paper collisions + annotation history (§3.2). Never say "knowledge graph."
4. **Design partners over analysis.** Recruit 5–10 beachhead labs (organizers are listed on lab websites); white-glove onboard them — import their last month of papers personally so memory isn't empty on day one. Their streaks are the direction check.
5. **One north-star metric: consecutive weekly sessions per lab.** 8+ consecutive = converted; two skips = churning regardless of what interviews say (self-report mirage, §4.3). Secondary: % of members annotating before each session (participation feeds the memory).

---

## 8. Agentic direction

Habits attach to events that already recur. V1 is **two loops**, both firing on the meeting's existing cadence:

1. **Presenter Agent (pre-session brief).** Assembles a cited agenda: typed collisions, unresolved questions from prior sessions, contradictions between members, relevant prior discussions, passages needing attention. Presenter approves/edits it. The scheduling machinery (`prepDigestJobId`) already ships — this is a delta, not a subsystem. Cited "Ask the Lab" retrieval lives *embedded inside this flow*, not as a standalone chat (standalone memory chat has no trigger and dies of being forgotten).
2. **Discussion-to-action.** During/after a session, selected annotations become: a decision, an open question, a proposed experiment, a reading task — with owner and due date. This closes the loop: this week's actions make next week's brief better.

Every agent action: shows sources, requires approval for side effects, respects private-note boundaries, is undoable, and is ledger-recorded.

**Deferred loops** (from the original audits — good roadmap, wrong v1): paper-triage-on-add ("what does this paper change for us?"), literature scout (monitor external literature against unresolved lab questions), lab-memory onboarding paths ("how do I ramp into this project?"), evidence-to-writing (claim/evidence/citation tables exported to Docs/Overleaf). Ship each only after the previous one holds a habit.

---

## 9. Roadmap

> **Execution order now lives in `docs/TIMELINE.md`** — that file is the dispatch queue and wins on sequencing. This section remains as phase rationale and shipped-state record.

Sprint-sized, sequenced by dependency. Given the team's shipping speed, phases are scoped in weeks, not months — but the *order* matters more than the dates.

> **Status update 2026-08-09:** PRs #41–#62 landed the bulk of Phases 0–2 in one day. Checkboxes below reflect `origin/main` at `87c9ca4`. What functionality remains open is marked; the current UX-fidelity track (reader rail, sessions, ingest, shell — the four polish PRs) is the §6 interaction-primitives work layered on top of these landed features.

### Phase 0 — Trust & the no-brainer baseline
- [x] Magic-link invites (#45) — **Google OAuth still open**
- [x] Membership-gated PDF delivery, per-fetch checks (#42, closes issue #9)
- [x] ⌘K global search drawer (#44), integrated into the interaction layer (#61)
- [x] Synthesis sign-off flow (#43)
- [x] Export everything (#48)
- [x] BibTeX/RIS bulk import (#47) — covers Zotero via export; **native Zotero sync still open**
- [x] @Mentions + notifications (#52) — **verify email delivery path**

### Phase 1 — The ritual, end to end
- [x] Presenter brief/agenda (#53)
- [x] Discussion-to-action: carry the meeting's outcomes out of the room (#55)
- [x] Calendar (.ics) for sessions (#50) — **Slack delivery still open**
- [x] Collections/tags/saved views + keyboard access (#54) — **session-agenda templates still open**
- [x] "Since you were away" producer (#49)
- [x] Reactions (#51)

### Phase 2 — The memory layer (quiet, underneath the ritual)
- [x] Event-source annotation edits — "an edit is an addition, not a destruction" (#57), with user-facing history
- [x] Cross-paper collision pairing (#56 — the `engine.ts:160` boundary, lifted)
- [x] Epistemic-status transitions (#60)
- [x] Temporal memory surfaces (#59)
- [x] Cross-page anchor recovery (#58)
- [ ] Objective eval harness: memory features vs the BM25/full-text baseline (GroupMemBench-style tasks on real lab data) — **open, and now the most important unbuilt item in this phase**

### Phase 3 — Compounding & expansion
- [ ] AI-*suggested* epistemic edges (contradiction candidates, related methods) — always suggestions until accepted
- [ ] Onboarding paths for new lab members (reading path through foundational papers, key debates, decisions)
- [ ] Paper-triage-on-add: "what does this change for us?" briefs
- [ ] Browser capture extension; public API
- [ ] Literature scout tied to unresolved lab questions
- [ ] Audio overview of the weekly synthesis (NotebookLM-style, but grounded in the lab's own reasoning)
- [ ] Optional exploration view over the derived index (the "map" — last, not first)

**Explicitly deferred / not building:** general block editor or docs workspace, lab chat, citation-manager replacement, native mobile apps, discovery search over the open corpus (integrate Elicit/OpenScholar-class tools instead), grading/course features, SSO/procurement (until a department asks), any pricing/monetization surface (standing directive: no pricing content anywhere in product or site).

---

## 10. What the future looks like (12–24 months)

A converted lab's reality: every paper the lab has ever discussed lives in one place, with every highlight attributed and every write-up traceable to its sources. A new PhD student's first week includes a generated reading path through the lab's foundational papers *and its actual debates about them*. The Thursday brief tells the presenter what the lab already believes, what it disputed last quarter, and which open question this week's paper might finally answer. When a result is retracted or a note withdrawn, every derived artifact that leaned on it updates itself. The PI can ask "why did we abandon that assay?" and get the passage, the person, the session, and the decision — in seconds.

By then, copies will exist. NotebookLM will have better models; a CHOIR-descendant will be open-sourced. The defense is that Margin holds each lab's accumulated reasoning — provenance-clean, exportable (which is *why* they trusted it with the data), and activated weekly — and that the product got two years of ritual-shaped polish the platforms won't prioritize for a niche they don't love.

---

## Appendix A — Debate verdicts (settled disputes)

| Dispute | Verdict |
|---|---|
| Moat: "accumulated reasoning" vs "provenance substrate" | Both: substrate is the moat, activation is the roadmap; joint test for every roadmap item |
| Graph memory now vs later | Neither doc's version. Bitemporal retraction-aware memory first; status typing as projection; temporal derived index; no graph DB, no graph marketing |
| "A lab-year fits in a context window" | Dead as architecture (~1M tokens realistic incl. page text; temporal/absence queries; cache economics). Survives only as a within-session tactic |
| ICP | 5–15, cadence-qualified, life-science/clinical as messaging + anchoring heuristic |
| Agentic surface | Two loops (brief in, actions out); Ask-the-Lab embedded, not standalone |
| "Annotations survive PDF variants" | Overclaimed — page-pinned today; fix in Phase 2 |
| "Nothing does this" | False as stated; true for the specific composition (group + passage-grounded + temporal + provenance) |

## Appendix B — Key sources (verified)

CHOIR arXiv:2509.20512 · GroupMemBench arXiv:2605.14498 · Governed Shared Memory arXiv:2606.24535 · Collaborative Memory arXiv:2505.18279 · Mem0 arXiv:2504.19413 · RAG vs GraphRAG arXiv:2502.11371 · GraphRAG arXiv:2404.16130 + critique arXiv:2506.06331 · PaperQA2 arXiv:2409.13740 · Zep arXiv:2501.13956 · ORKG arXiv:2005.10334 · Meister 2017 (ceur-ws.org/Vol-1931/paper-10.pdf) · TMS meta-analysis DOI 10.1177/10464964261434540 · Product docs: scholars.io, foreground-jc.com, web.hypothes.is, NotebookLM help, greptile.com/docs.
