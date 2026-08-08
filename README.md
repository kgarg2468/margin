<h1 align="center">Margin</h1>

<p align="center">
  <img src="docs/assets/brand/margin-wordmark.png" alt="" width="300">
</p>

<p align="center">
  <strong>The collective intelligence layer for research groups.</strong>
</p>

<p align="center">
  Margin is a journal club platform where a lab annotates papers together in a shared margin, and the typed notes it leaves become a durable, queryable record of what the group actually argued about.
</p>

<p align="center">
  <a href="https://margin-ochre-three.vercel.app/"><strong>Live website</strong></a>
</p>

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3B2F2A?style=for-the-badge&logo=typescript&logoColor=white">
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-15-4068A0?style=for-the-badge&logo=nextdotjs&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-19-3B2F2A?style=for-the-badge&logo=react&logoColor=white">
  <img alt="Tailwind" src="https://img.shields.io/badge/Tailwind-v4-4068A0?style=for-the-badge&logo=tailwindcss&logoColor=white">
  <img alt="Convex" src="https://img.shields.io/badge/Convex-Backend-3B2F2A?style=for-the-badge&logo=convex&logoColor=white">
  <img alt="OpenAI" src="https://img.shields.io/badge/OpenAI-Synthesis-4068A0?style=for-the-badge">
  <img alt="pdf.js" src="https://img.shields.io/badge/pdf.js-Reader-3B2F2A?style=for-the-badge">
  <img alt="Playwright" src="https://img.shields.io/badge/Playwright-CI-4068A0?style=for-the-badge">
  <img alt="Vercel" src="https://img.shields.io/badge/Vercel-Frontend-3B2F2A?style=for-the-badge&logo=vercel&logoColor=white">
</p>

## Product

Margin is where a research group runs its journal club. A lab brings in a paper by DOI, annotates it together in a shared margin before the meeting, and runs the discussion off the passages it flagged. Every note carries a type — hypothesis, method note, critique, definition, connection, open question — so the reading leaves a structured record instead of a drawer of highlights, and that record is what the next session, the next member, and the write-up are built from. The model layer only ever quotes and attributes what the lab already said.

The product stays in its warm brown dark mode throughout:

<p align="center">
  <img src="docs/assets/screenshots/landing-dark.png" alt="Margin landing page in warm dark mode, with the first annotation visible" width="100%">
</p>
<p align="center"><em>Fig. 1 — The landing page, where the page itself demonstrates a shared margin.</em></p>

<p align="center">
  <img src="docs/assets/screenshots/reader.png" alt="Margin reader in warm dark mode, showing anchored passages and the typed margin rail" width="100%">
</p>
<p align="center"><em>Fig. 2 — The reader: typed notes anchored to passages in one paper.</em></p>

<p align="center">
  <img src="docs/assets/screenshots/composer.png" alt="Margin annotation composer in warm dark mode, open on a live text selection" width="100%">
</p>
<p align="center"><em>Fig. 3 — The composer: choose a note type and visibility before saving the thought.</em></p>

<p align="center">
  <img src="docs/assets/screenshots/session-live.png" alt="Margin live session projector in warm dark mode, with a populated typed passage board" width="100%">
</p>
<p align="center"><em>Fig. 4 — The live session: the room runs from the passages the lab flagged.</em></p>

<p align="center">
  <img src="docs/assets/screenshots/synthesis.png" alt="Margin session write-up in warm dark mode, with attribution and citations" width="72%">
</p>
<p align="center"><em>Fig. 5 — The write-up: every claim is quoted from an annotation and attributed to its author.</em></p>

## First Session

| Step | A lab's first journal club | Margin output |
| --- | --- | --- |
| Ingest | Someone pastes a DOI | Crossref record, open-access PDF, per-page extracted text layer |
| Annotate | Members read into the margin beforehand | Typed marginalia anchored to passages, visibility-controlled |
| Prep | Two hours before the meeting | Digest of gold collisions, passage-addressed, capped at 5 |
| Discuss | The meeting runs off what the lab flagged | Live typed passage board; private notes never shown |
| Record | The session ends | Quote-and-attribute synthesis, sectioned by annotation type |

```mermaid
flowchart LR
  DOI["DOI"] --> Text["Extracted text layer"]
  Text --> Notes["Typed marginalia"]
  Notes --> Ledger["Append-only ledger"]
  Ledger --> Digest["Boundary digest, capped at 5"]
  Digest --> Board["Live passage board"]
  Board --> Writeup["Quote-and-attribute synthesis"]
```

## Architecture

| Layer | Stack | Role |
| --- | --- | --- |
| Frontend | Next.js 15 App Router, React 19, Tailwind v4 | Landing, reader, margin rail, session projector, session record |
| Backend | Convex — database, actions, scheduler, file storage | Papers, annotations, sessions, digests, stored PDFs |
| Auth | Convex Auth, password provider | Email and password hashed on the deployment; every lab-scoped read authorized against `memberships` |
| Ledger | Append-only `events` table | The provenance record: every meaningful act in a lab, never updated, never deleted |
| Anchoring | W3C-style redundant selectors, fuzzy re-anchoring | Annotations survive PDF variants; drift is surfaced rather than silently moved; 78 unit tests |
| Digests | Deterministic typed-pair collision detection | Simulation-validated cap-5 policy, per-recipient staleness cursors, no model in the loop |
| Synthesis | OpenAI Responses API, structured outputs | Sectioned write-up; attribution derived from the citations, never taken from the model |
| CI | GitHub Actions, Vitest, Playwright, Greptile | Lint, types, 149 unit tests, backend-free browser smoke, privacy-constitution guard, review |

```mermaid
flowchart TD
  Reader["Reader"] --> Annotations["Typed annotations"]
  Annotations --> Ledger["Append-only ledger"]
  Ledger --> Collisions["Typed-pair collision detection"]
  Collisions --> Digests["Per-recipient digests, hard cap 5"]
  Digests --> Prep["Session prep"]
  Prep --> Session["Live session"]
  Session --> Synthesis["Synthesis, OpenAI Responses API"]
  Synthesis -->|"quotes and attributes, never generates claims"| Record["Session record"]
  Privacy["Privacy constitution: no read tracking. Evidence is only what members write."] -.-> Reader
  Privacy -.-> Ledger
  Privacy -.-> Synthesis
```

## What It Proves

| Product question | Margin answer |
| --- | --- |
| Can an annotation survive a different copy of the same PDF? | Yes. Every anchor carries a text-quote selector with prefix and suffix context alongside position offsets, and re-anchors fuzzily; when a passage moves, the note says so with a drift badge instead of pointing at the wrong sentence. |
| Can a lab see where it is converging without surveillance? | Yes. Convergence is computed from typed-pair collisions between notes members chose to write. There is no read tracking anywhere in the system, and a CI schema guard fails the build if any is added. |
| Can AI be trusted inside scholarship? | Yes. The synthesis is constrained to quote and attribute existing annotations rather than generate claims, and attribution is derived from the citations it emits, so a stored name cannot be one the model chose. |
| Can delivery avoid notification fatigue? | Yes. Digests are computed at boundaries rather than on write, addressed per recipient from a staleness cursor, and hard-capped at five items — a shape validated by simulation across lab sizes 5 to 25. |
| Is the privacy stance mechanical rather than editorial? | Yes. The guard reads `convex/schema.ts` back through Convex's own validator introspection, so a `reads` table, a `viewedAt` field, or a read event type is a failing build rather than a broken promise. |

## View

| Link | URL |
| --- | --- |
| Live website | https://margin-ochre-three.vercel.app/ |
| YouTube walkthrough | Coming soon |
