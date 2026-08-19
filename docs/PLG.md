# Product-Led Growth — making Margin something researchers pick up on their own

**Date:** 2026-08-18
**Method:** a read-only audit of Margin's actual new-user funnel (every gate verified in code — `.context/research/sol-plg-funnel.md`) crossed with adoption-mechanics research on the researcher tools that spread bottom-up and the ones that died (sources in the research memo; key numbers cited inline).
**Relationship to other docs:** `docs/X-FACTOR.md` answered *who pays and what's fundable*. This doc answers *how the product itself acquires users*. They compose: every X-factor stage assumed a funnel of labs — this is the machine that produces it. `docs/TIMELINE.md` stays the execution source of truth; §7 below proposes how this slots in.

---

## 1. The diagnosis, in one paragraph

Margin is built as if the lab arrives together. In reality one researcher arrives alone, on a Tuesday, with a PDF. Today that researcher hits **eight actions** before a paper is guaranteed open in the reader — and the first thing the product asks is to *invent a lab name and become a "PI"* before they can store a single paper. There is **no public surface at all**: every artifact (annotated paper, brief, synthesis) requires full lab membership just to *view*, so nothing can spread. Product-led growth — **PLG**, where the product itself does the acquiring: free entry, fast value, shareable output, payment triggered by usage — fails at step one. The fix is not a rewrite. The audit found no gate anywhere that requires more than one member; a one-person lab already works. The product is *accidentally* solo-capable and deliberately hidden about it.

## 2. What the winners did (the evidence, compressed)

Four mechanics repeat across every researcher tool that spread bottom-up:

1. **Value alone, in minutes.** Overleaf's whole trick was "no LaTeX install, one click to a compiling doc" → 20M+ users. Mendeley won by ingesting the PDF pile you *already had* (525M documents uploaded by 2014). The solo job must fully stand alone — collaboration is the upgrade, not the entry.
2. **The viewer needs no account; the account wall sits at *contributing*.** Overleaf's link-sharing: viewers free forever, editors must sign up. That single rule is the viral loop — the artifact carries the product to the next user, and the next user only pays the signup cost at the moment they want to participate.
3. **Output that leaves the product is the marketing.** NotebookLM's audio overviews spread on social media where the product wasn't. The artifact does the advertising.
4. **Discovery is in-workflow, not word-of-mouth.** The measured data (76-person diary study): tools get discovered by *encountering them in the workflow* (60%) and *watching a colleague use one* (39%). Direct recommendation is the **worst** channel at 6%. Translation: you don't spread by being talked about; you spread by being *seen in use*.

And the anti-patterns — all of which Margin's current shape flirts with:

- **PubMed Commons died** (0.02% of articles got a comment) because contributing required behavior outside the existing workflow, gated by identity ceremony.
- **Nanopublications/ORKG died** because the producer pays cost now for value that's deferred and abstract.
- **Hypothesis stalled** (270k users in 14 years vs Overleaf's 20M) because annotation is a low-frequency act nobody's forced to do — its only real growth came from LMS mandates.
- **PaperHive/Authorea/colwiz died or sold** because they depended on publishers for their content substrate. (Margin is safe here — labs bring their own PDFs.)

**Willingness-to-pay reality:** individual researchers pay **$10–12/mo** (Overleaf student $10, scite $12, Elicit $10–12, Paperpal $12, ResearchRabbit $12.50). They pay for exactly two things: **volume of a job they already do** (Elicit credits, Zotero storage) or **collaboration depth** (Overleaf's collaborator cap). Nobody successfully charges for access to the core artifact.

## 3. The ladder — Margin redesigned as four rungs

The product keeps everything it has. What changes is that each layer works before the next one exists.

### Rung 0 — See it without an account

A **read-only public link** for an annotated paper and for a signed-off synthesis. Anyone with the link sees the paper with the margin conversation alongside — no signup, no wall. The wall appears exactly where Overleaf put it: the moment you want to *add* a note, you sign in.

This is the single highest-leverage missing piece. It simultaneously creates: the viral artifact (mechanic 3), the in-workflow encounter (mechanic 4 — a shared Margin link in a lab's Slack *is* the discovery event), and permissionless viewing (mechanic 2). Today sharing anything grants full lab membership — that's not sharing, that's onboarding.

Constraints that make this safe (all machinery exists): only lab-visible annotations ever render (private notes structurally excluded); withdrawal revocation applies on every read, same as synthesis; sharing is opt-in per artifact by the people whose notes appear, consistent with the sign-off model; unlisted-by-default URLs.

### Rung 1 — Useful alone in three actions

Sign up → paste DOI or drop PDF → you're reading. The audit's three cheap changes, adopted verbatim:

1. **Auto-provision a personal library at signup** (an invisible one-member lab — the model already supports it). Nobody invents a lab name or becomes a "PI" to read a paper.
2. **Land new users in the library with the add-paper panel open**, not on organizational setup.
3. **Jump straight into the reader after ingest**, not to a record page.

Eight actions become three. Then make the solo experience actually compound: the memory features mostly work for one person already (temporal views, history, epistemic status, search), with one deliberate exception — the catch-up digest excludes your own notes, because it assumes "colleagues wrote things while you were away." Add a solo mode where **your past self is the colleague**: "you flagged this same assay in March — here's your note." That's the Margin thesis, delivered to a single user, no lab required. Come for the reader and the memory of your own reading; stay for the lab.

Also: **seed the empty state.** A brand-new library should contain one classic annotated paper (the marketing fixture, made real) so the first screen *demonstrates* the margin-conversation idea instead of showing a form. Empty states are where cold starts die.

### Rung 2 — The second person costs one click

- Invite link → Google OAuth/magic link (shipped) → they're reading the same paper. No password ceremony (shipped), no lab-naming (fixed by rung 1 — inviting from a personal library quietly names/converts it).
- A **viewer/guest tier** on shared artifacts: someone who arrived via a rung-0 link and signed up can comment on that one paper without full lab membership. (Schema note: membership roles are exactly `pi|member` today — this needs a deliberate third state, flag for design.)

### Rung 3 — The ritual (the existing product)

Sessions, briefs, board, synthesis, outcomes, scout. Unchanged — but now it's the *upgrade path* instead of the front door. And note what a live session physically is: **one presenter driving Margin on a projector in front of 5–15 researchers**. That is the peer-observation channel (39% of tool discovery) firing weekly, for free. The projected board view deserves polish budget for exactly this reason — every session is a ten-person demo (Track A2 suddenly has a growth justification, not just a UX one).

## 4. Where the money enters (PLG-native, no sales team)

Following the evidence — charge on volume or collaboration depth, never on the core artifact:

- **Free forever:** reading, annotating, personal memory, small-lab collaboration, export. (Export stays free always — it's the trust feature that makes labs willing to deposit their reasoning.)
- **The paid line** (pick by evidence later, both fit the $10–12/mo anchor): AI volume (briefs/syntheses/scout runs per month — metering a job the lab already does weekly) and/or lab size/depth beyond a threshold (the Overleaf collaborator-cap pattern). The X-FACTOR writing surface (draft-with-provenance) slots in here as the premium artifact when it ships.
- **The standing conflict to resolve:** the project rule bans pricing content anywhere in product or site. PLG monetization eventually requires an upgrade surface *in the product*. No action now — free tier needs to win first regardless — but this directive needs a founder revisit before any paid line ships.

Funding story in one line: PLG metrics *are* the pitch — signup→first-paper conversion, solo→lab conversion, link-share coefficient (how many new signups each shared artifact produces), and the existing north star (8+ consecutive sessions). Overleaf and Figma raised on exactly these curves.

## 5. What we deliberately do NOT do

- **No public-by-default anything.** Private candor is the product's trust foundation; rung 0 is opt-in per artifact, unlisted URLs, whole-item revocation on read.
- **No engagement mechanics that manufacture annotation.** Hypothesis proves forced annotation doesn't spread and the constitution bans surveillance-shaped nudges. Annotation stays a byproduct of reading.
- **No feed, no social network.** The viral unit is the artifact, not a timeline.
- **No funnel analytics that violate the constitution.** Signup and conversion counts are fine; read/dwell tracking stays banned. Growth instrumentation gets reviewed against the CI privacy guards like everything else.

## 6. The build list (roughly ordered, all small-to-medium)

| # | Item | What it unlocks | Size |
|---|---|---|---|
| P1 | Personal library at signup + land-in-library + straight-to-reader | 8 actions → 3; solo entry exists | S |
| P2 | Read-only share links: annotated paper + synthesis (opt-in, unlisted, revocation-on-read) | The viral loop; first public surface | M |
| P3 | Solo catch-up/collision mode ("your past self is the colleague") | Solo memory value; the thesis without a lab | S–M |
| P4 | Seeded demo paper in every new library | Empty state demonstrates value | S |
| P5 | Invite-from-personal-library (quiet lab conversion) + guest/viewer state on shared artifacts | Second user costs one click | M (schema) |
| P6 | Projected-board polish (rides Track A2) | The weekly 10-person demo | (already planned) |
| P7 | Share-link → signup → "annotate this paper" continuity | Closes rung 0 → rung 1 | S |

P1+P4 alone would transform the first five minutes. P2 is the strategic one — it's the only item that makes growth *compound*.

## 7. Proposed TIMELINE placement (needs a go decision — nothing dispatched)

New **Track P (PLG core): P1–P7 above.** P1/P3/P4 are independent of everything in flight. P2/P5/P7 touch auth/membership surfaces — sequence after B1's OAuth (shipped) and coordinate with the conflict map. Recommendation: **Track P's P1–P4 run before or alongside X-FACTOR's Track E** — the retraction sentinel gives labs a reason to *talk about* Margin; the share link is what they'd *send*. The two tracks are one funnel: P-track gets the researcher in alone; E-track gives the lab a reason to stay and pay.
