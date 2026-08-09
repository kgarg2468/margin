"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { downloadText, exportFilename } from "@/lib/export/download";
import { sessionWriteUpToMarkdown } from "@/lib/export/markdown";
import { relativeWhen } from "@/lib/sessions-ui";
import {
  errorClass,
  eyebrowClass,
  primaryButtonClass,
  secondaryButtonClass,
  skeletonClass,
} from "@/lib/ui";
import type { FunctionReturnType } from "convex/server";
import { useAction, useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { useState } from "react";
import { readableError } from "../../../_components/errors";
import { annotationAnchorId } from "./session-board";
import type { SessionDetail } from "./manage";

type Synthesis = NonNullable<
  FunctionReturnType<typeof api.synthesis.getForSession>
>;
type Section = Synthesis["sections"][number];

/**
 * The write-up: the draft a model made, and the copy a person signed.
 *
 * The draft is in the violet the design tokens hold in reserve for a second
 * voice. That is the whole trust posture in a colour: the lab's own writing is
 * espresso, and the machine's re-arrangement of it is visibly not. The
 * approved copy comes back to espresso, because by then a person has read
 * every line of it and put the lab's name on it — the colour tracks
 * authorship, so a reader never has to ask which of the two they are looking
 * at.
 *
 * ## Attribution is checked here, not trusted
 *
 * A synthesis item carries the ids of the annotations it was drawn from, and
 * those ids were resolved when the write-up was generated. The margin has moved
 * since: notes get withdrawn, and a member can flip a note from lab-visible
 * back to private. So an item's citations are re-checked against the
 * annotations this client can *currently* see, on two thresholds:
 *
 * - **No citation still visible** — the sentence is redacted, not just
 *   unlinked. A synthesis item is derived from the notes it cites; if every
 *   one of them has been withdrawn, the item is a paraphrase of writing the
 *   reader is no longer allowed to read, and leaving it on the page would make
 *   the write-up a way around `visibility: "private"`.
 * - **Some citation withdrawn** — the sentence stands, because at least one
 *   note behind it is still shared, but the attribution line goes. Names come
 *   from the union of the cited notes and can't be mapped back to individual
 *   ids, so a partial withdrawal means we can no longer prove any particular
 *   name is still owed.
 *
 * Both thresholds are read from live annotation data, never from what the
 * write-up stored at generation time.
 *
 * ## The approved copy cannot do that, and says so
 *
 * Prose a person wrote has no citations to re-check — nobody can tell which
 * sentence came from which note. So the approved copy is never quietly
 * rewritten and never quietly left to rot either: the server compares the
 * citation snapshot it was approved against with what is still shared today,
 * and anything missing raises a banner asking for a fresh reading. Same for
 * re-generation: the draft can be rewritten as often as the lab likes, and the
 * page says in as many words that the approved copy stands until somebody
 * approves a new one.
 */

/** Canonical order and a heading for a section whose own is missing. */
const SECTION_ORDER: readonly {
  key: Section["key"];
  fallback: string;
}[] = [
  { key: "summary", fallback: "What the session was about" },
  { key: "open-questions", fallback: "Open questions" },
  { key: "critiques-and-methods", fallback: "Critiques and methods" },
  { key: "connections", fallback: "Connections" },
  { key: "next-reading", fallback: "What to read next" },
];

export function SessionSynthesis({
  session,
  visibleAnnotationIds,
}: {
  session: SessionDetail;
  /**
   * Every annotation this client can currently see on the paper. A citation is
   * only rendered as a link when its id is in here.
   */
  visibleAnnotationIds: ReadonlySet<Id<"annotations">>;
}) {
  const synthesis = useQuery(api.synthesis.getForSession, {
    sessionId: session._id,
  });
  const generate = useAction(api.synthesis.generate);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);

  const has = synthesis !== undefined && synthesis !== null;
  const approved = session.synthesis;
  const approvedAt = session.synthesisApprovedAt;
  const isApproved = approved !== undefined && approvedAt !== undefined;
  const title = session.title ?? session.paperTitle ?? "Session write-up";
  // The download prefers the approved copy — the version a person signed —
  // and falls back to the generated draft, redactions and all.
  const canDownload = approved !== undefined || has;

  return (
    <section className="flex flex-col gap-10">
      {isApproved && (
        <ApprovedWriteUp
          text={approved}
          approvedAt={approvedAt}
          // Before the query lands there is nothing to claim about staleness,
          // and a banner that appears a beat later is worse than one that was
          // always there. `undefined` renders neither.
          withdrawnSince={
            has && synthesis.approval !== null
              ? synthesis.approval.withdrawnSince
              : undefined
          }
          rewrittenSince={has && synthesis.generatedAt > approvedAt}
        />
      )}

      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h2
            style={{ color: "var(--secondary)" }}
            className="font-sans text-xs font-medium uppercase tracking-[0.18em]"
          >
            {isApproved ? "The draft it was made from" : "Write-up"}
          </h2>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
            {has && (
              <span className="font-sans text-xs text-ink-faint">
                {synthesis.model} · {relativeWhen(synthesis.generatedAt)}
              </span>
            )}
            {canDownload && (
              <button
                type="button"
                onClick={() =>
                  downloadText(
                    sessionWriteUpToMarkdown({
                      title,
                      approvedSynthesis: approved,
                      generatedSections: synthesis?.sections,
                      visibleAnnotationIds,
                    }),
                    exportFilename(title, "md"),
                    "text/markdown;charset=utf-8",
                  )
                }
                className="font-sans text-xs text-ink-faint underline-offset-4 hover:text-accent hover:underline"
              >
                Download .md
              </button>
            )}
          </div>
        </div>

        {synthesis === undefined ? (
          <span
            role="status"
            aria-label="Loading"
            className={`${skeletonClass} h-6 w-56`}
          />
        ) : synthesis === null ? (
          <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
            No write-up yet. It is one pass over what the lab wrote, and it may
            only quote and attribute those notes — it never adds a claim of its
            own.
          </p>
        ) : (
          <div className="flex flex-col gap-8">
            {SECTION_ORDER.map(({ key, fallback }) => {
              const section = synthesis.sections.find((one) => one.key === key);
              if (section === undefined || section.items.length === 0) {
                return null;
              }
              return (
                <SynthesisSection
                  key={key}
                  section={section}
                  fallback={fallback}
                  visibleAnnotationIds={visibleAnnotationIds}
                />
              );
            })}
          </div>
        )}

        {editing && has ? (
          <ApprovalEditor session={session} onDone={() => setEditing(false)} />
        ) : (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            {session.canApprove && has && (
              <button
                type="button"
                className={
                  isApproved ? secondaryButtonClass : primaryButtonClass
                }
                onClick={() => setEditing(true)}
              >
                {isApproved ? "Revise and approve again" : "Edit and approve"}
              </button>
            )}

            {session.canManage && (
              <button
                type="button"
                disabled={pending}
                className={secondaryButtonClass}
                onClick={async () => {
                  setError(null);
                  setPending(true);
                  try {
                    await generate({ sessionId: session._id });
                  } catch (caught) {
                    // Every refusal the action makes — no API key on the
                    // deployment, nothing shared to quote, a model that
                    // declined, a call that timed out, a run already in flight
                    // — arrives as a ConvexError carrying the sentence it wants
                    // shown. Passing it through is what surfaces each one
                    // distinctly; a client-side taxonomy would only be a worse
                    // copy of the server's.
                    setError(
                      readableError(
                        caught,
                        "The write-up couldn't be generated. Try again.",
                      ),
                    );
                  } finally {
                    setPending(false);
                  }
                }}
              >
                {pending
                  ? "Writing…"
                  : has
                    ? "Write the draft again"
                    : "Generate write-up"}
              </button>
            )}

            {session.canManage && isApproved && (
              <span className="max-w-prose font-sans text-xs text-ink-faint">
                Writing it again replaces the draft only. The approved copy
                above stands until somebody approves a new one.
              </span>
            )}

            {pending && (
              <span
                aria-live="polite"
                className="font-sans text-xs text-ink-faint"
              >
                One pass over the session&rsquo;s margin. This takes a minute.
              </span>
            )}
          </div>
        )}

        {/* The write-up drafting itself, in the second voice's ink — the same
            gesture as the landing's synthesis scene, at working scale. A ghost
            of the paragraphs that are coming, breathing while the model reads. */}
        {pending && (
          <div
            aria-hidden
            className="pop-in flex max-w-prose flex-col gap-2.5 border-l-2 pl-4"
            style={{ borderColor: "var(--secondary)" }}
          >
            {(["100%", "92%", "61%"] as const).map((width, i) => (
              <span
                key={width}
                className={`${skeletonClass} h-4`}
                style={{
                  width,
                  backgroundColor:
                    "color-mix(in oklab, var(--secondary) 13%, transparent)",
                  animationDelay: `${i * 160}ms`,
                }}
              />
            ))}
          </div>
        )}

        {error !== null && (
          <p
            role="alert"
            aria-live="polite"
            className={`${errorClass} max-w-prose`}
          >
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The lab's own copy: what somebody edited, approved, and stands behind.
 *
 * It leads the section because it is the answer to "what did we work out" —
 * the draft below it is provenance. Two things can be true of it that the text
 * itself cannot say, and both are said here rather than left for a reader to
 * discover: a note it was checked against has been withdrawn, or the draft has
 * been rewritten since anyone approved this.
 */
function ApprovedWriteUp({
  text,
  approvedAt,
  withdrawnSince,
  rewrittenSince,
}: {
  text: string;
  approvedAt: number;
  withdrawnSince: number | undefined;
  rewrittenSince: boolean;
}) {
  const stale = withdrawnSince !== undefined && withdrawnSince > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 className={eyebrowClass}>The lab&rsquo;s write-up</h2>
        <span className="font-sans text-xs text-ink-faint">
          Approved {relativeWhen(approvedAt)}
        </span>
      </div>

      {stale && (
        <p role="status" className={`${errorClass} max-w-prose`}>
          {withdrawnSince === 1
            ? "A note this write-up was checked against has been withdrawn or made private since it was approved."
            : `${withdrawnSince} of the notes this write-up was checked against have been withdrawn or made private since it was approved.`}{" "}
          It is a record somebody wrote, so nothing in it rewrites itself — read
          it through and approve it again once it says what the lab means.
        </p>
      )}

      {rewrittenSince && !stale && (
        <p
          role="status"
          className="max-w-prose border-l-2 border-rule pl-3 font-sans text-sm text-ink-muted"
        >
          The draft below has been written again since this was approved. This
          copy is still the lab&rsquo;s write-up until a new one is approved.
        </p>
      )}

      <ApprovedProse text={text} />
    </div>
  );
}

/** A block of the approved copy, in the order it was written. */
type Block =
  | { kind: "heading"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "paragraph"; text: string };

/**
 * Markdown, as much of it as this surface promises.
 *
 * The editor hands people a markdown draft, so the copy has to render headings
 * and bullets or the `##` a person never touched shows up in the lab's record.
 * It stops there deliberately: a real markdown pipeline is a dependency and an
 * HTML-injection surface, in exchange for emphasis marks nobody has asked for.
 * Anything it does not recognise is a paragraph — the text always survives.
 */
function toBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;

    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading?.[1] !== undefined) {
      blocks.push({ kind: "heading", text: heading[1] });
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet?.[1] !== undefined) {
      const last = blocks.at(-1);
      if (last?.kind === "list") {
        last.items.push(bullet[1]);
      } else {
        blocks.push({ kind: "list", items: [bullet[1]] });
      }
      continue;
    }

    blocks.push({ kind: "paragraph", text: line });
  }
  return blocks;
}

function ApprovedProse({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-5">
      {toBlocks(text).map((block, index) => {
        if (block.kind === "heading") {
          return (
            <h3 key={index} className={eyebrowClass}>
              {block.text}
            </h3>
          );
        }
        if (block.kind === "list") {
          return (
            <ul key={index} className="flex flex-col gap-3">
              {block.items.map((item, position) => (
                <li
                  key={position}
                  className="max-w-prose border-l-2 border-rule pl-3.5 font-serif text-base leading-relaxed text-ink"
                >
                  {item}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p
            key={index}
            className="max-w-prose font-serif text-base leading-relaxed text-ink"
          >
            {block.text}
          </p>
        );
      })}
    </div>
  );
}

/**
 * The approval form: the draft as editable text, and the button that makes it
 * the lab's.
 *
 * A textarea rather than an editor. What is being edited is a page of prose
 * somebody will read once, and every affordance past "type words" would be a
 * dependency, a toolbar, and a new way for the record of a meeting to be
 * fiddled with instead of written.
 *
 * The draft is fetched rather than rebuilt from the sections on screen,
 * because the server assembles it from the *redacted* write-up — the version
 * this reader is allowed to have — and a client-side assembly would be a
 * second implementation of that rule with no test behind it.
 */
function ApprovalEditor({
  session,
  onDone,
}: {
  session: SessionDetail;
  onDone: () => void;
}) {
  const draft = useQuery(api.synthesis.draftForApproval, {
    sessionId: session._id,
  });
  const approved = session.synthesis;
  const approvedAt = session.synthesisApprovedAt;

  if (draft === undefined) {
    return (
      <span
        role="status"
        aria-label="Loading the draft"
        className={`${skeletonClass} h-40 w-full`}
      />
    );
  }

  if (draft === null) {
    return (
      <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
        There&rsquo;s no draft to approve. Generate the write-up first — what
        gets approved is a version of something the lab&rsquo;s own notes back.
      </p>
    );
  }

  // What the box is seeded with decides what its citations are, so the two are
  // chosen in one breath and never separately. An approved copy is what the
  // approver last said and opening on anything else would throw their edits
  // away — and a revision of that copy rests on the notes *it* was approved
  // against, not on a draft the prose has never seen.
  const seeded: Basis =
    approved !== undefined && approvedAt !== undefined
      ? { from: "approved", approvedAt }
      : { from: "draft", generatedAt: draft.generatedAt };

  return (
    <ApprovalForm
      session={session}
      initial={approved ?? draft.markdown}
      seededFrom={seeded}
      draft={draft}
      onDone={onDone}
    />
  );
}

/** Which version the text in the box came from — see `approve` in convex. */
type Basis =
  | { from: "draft"; generatedAt: number }
  | { from: "approved"; approvedAt: number };

/**
 * `draft` and `session` are live; `basis` is not, and that difference is the
 * point.
 *
 * The form stays open for as long as it takes to read a page and rewrite it.
 * A generation run can replace the draft underneath the person editing, and
 * another approver can publish a new copy. The subscriptions notice; the text
 * in the box does not. So what the text was actually written against is pinned
 * in state when it is seeded and moves only when the approver deliberately
 * moves it — which is what lets the mismatch be *seen* here and refused on the
 * server, rather than quietly papered over by sending whatever version
 * happened to be current at the moment somebody clicked.
 *
 * Moving it is two different offers, and the difference matters: taking the
 * new draft's text means taking its citations, while keeping your own text
 * means keeping the ones it was written against. Neither is chosen for the
 * approver.
 */
function ApprovalForm({
  session,
  initial,
  seededFrom,
  draft,
  onDone,
}: {
  session: SessionDetail;
  initial: string;
  seededFrom: Basis;
  draft: { markdown: string; generatedAt: number };
  onDone: () => void;
}) {
  const approve = useMutation(api.synthesis.approve);
  const [text, setText] = useState(initial);
  const [basis, setBasis] = useState<Basis>(seededFrom);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const moved =
    basis.from === "draft"
      ? draft.generatedAt !== basis.generatedAt
      : session.synthesisApprovedAt !== basis.approvedAt;

  /** Keep this text, and stand behind it against the version that is there now. */
  function rebind() {
    if (basis.from === "draft") {
      setBasis({ from: "draft", generatedAt: draft.generatedAt });
    } else if (session.synthesisApprovedAt !== undefined) {
      setBasis({ from: "approved", approvedAt: session.synthesisApprovedAt });
    }
  }

  return (
    <div className="pop-in flex flex-col gap-3">
      <label htmlFor="synthesis-approval" className={eyebrowClass}>
        The lab&rsquo;s write-up
      </label>
      <p className="max-w-prose font-sans text-xs text-ink-faint">
        {basis.from === "draft"
          ? "Assembled from the draft, attributions and all. Cut it, rewrite it, say what the model missed — what you approve is what the lab keeps."
          : "The copy the lab has now. It stays checked against the notes it was approved against — start again from the draft to check it against that instead."}
      </p>

      {moved && (
        <p role="status" className={`${errorClass} max-w-prose`}>
          {basis.from === "draft"
            ? "The draft was written again while this was open, so what you have here no longer matches the write-up it came from."
            : "Somebody else approved a new version while this was open, so what you have here is no longer the lab's copy."}{" "}
          Nothing you typed has been touched — read what&rsquo;s there now, then
          say which of them this is.
        </p>
      )}

      <textarea
        id="synthesis-approval"
        rows={18}
        value={text}
        maxLength={40_000}
        onChange={(event) => setText(event.target.value)}
        placeholder="What the lab worked out…"
        className="w-full resize-y rounded-sm border border-rule bg-surface px-3 py-2 font-serif text-base leading-relaxed text-ink placeholder:text-ink-faint transition-colors hover:border-ink-faint"
      />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <button
          type="button"
          // Disabled while the draft has moved, rather than left to fail: the
          // server refuses this pairing anyway, and a button that is certain
          // to be refused should say so before it is pressed. The round trip
          // still guards the narrower race — a run landing between this click
          // and the mutation.
          disabled={pending || moved || text.trim().length === 0}
          className={primaryButtonClass}
          onClick={async () => {
            setError(null);
            setPending(true);
            try {
              await approve({ sessionId: session._id, text, basis });
              onDone();
            } catch (caught) {
              setError(
                readableError(caught, "That write-up didn't get approved."),
              );
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? "Approving…" : "Approve write-up"}
        </button>

        {moved && (
          // The person is the only one who can say whether their edits still
          // hold against a version that has changed, so both answers are
          // offered and neither is taken for them: keep the text and stand
          // behind it, or take what is there now and lose it.
          <button
            type="button"
            onClick={rebind}
            className="font-sans text-sm text-accent underline-offset-4 hover:underline"
          >
            {basis.from === "draft"
              ? "My text still stands — approve against the new draft"
              : "My text still stands — approve it over that version"}
          </button>
        )}

        {draft.markdown !== text && (
          // Taking the draft's text takes the draft's citations with it. That
          // is the one move that may re-point what this copy is checked
          // against, and it is only ever made on purpose.
          <button
            type="button"
            onClick={() => {
              setText(draft.markdown);
              setBasis({ from: "draft", generatedAt: draft.generatedAt });
            }}
            className="font-sans text-sm text-accent underline-offset-4 hover:underline"
          >
            {moved && basis.from === "draft"
              ? "Start again from the new draft"
              : "Start again from the draft"}
          </button>
        )}

        <button
          type="button"
          onClick={onDone}
          className="font-sans text-sm text-ink-faint underline-offset-4 hover:text-accent hover:underline"
        >
          Discard changes
        </button>
      </div>

      {error !== null && (
        <p role="alert" aria-live="polite" className={`${errorClass} max-w-prose`}>
          {error}
        </p>
      )}
    </div>
  );
}

function SynthesisSection({
  section,
  fallback,
  visibleAnnotationIds,
}: {
  section: Section;
  fallback: string;
  visibleAnnotationIds: ReadonlySet<Id<"annotations">>;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className={eyebrowClass}>
        {section.heading.length > 0 ? section.heading : fallback}
      </h3>
      <ul className="flex flex-col gap-5">
        {section.items.map((item, index) => {
          const cited = item.annotationIds.filter((id) =>
            visibleAnnotationIds.has(id),
          );
          const withdrawn =
            item.annotationIds.length > 0 && cited.length === 0;
          const partial = cited.length < item.annotationIds.length;
          return (
            <li
              key={`${section.key}-${index}`}
              style={{ borderLeftColor: "var(--secondary)" }}
              className="border-l-2 pl-3.5"
            >
              {withdrawn ? (
                // The line itself is redacted, not merely unlinked: it was
                // written out of notes that are no longer shared with this
                // reader. Saying a line was here keeps the record honest —
                // silently dropping it would make the write-up look shorter
                // than the meeting was.
                <p className="max-w-prose font-serif text-base italic leading-relaxed text-ink-faint">
                  A line here rested on notes that are no longer shared.
                </p>
              ) : (
                <>
                  <p className="max-w-prose font-serif text-base leading-relaxed text-ink">
                    {item.text}
                  </p>
                  <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-sans text-xs text-ink-faint">
                    {!partial && item.attribution.length > 0 && (
                      <span>{item.attribution.join(", ")}</span>
                    )}
                    {cited.map((id, position) => (
                      <a
                        key={id}
                        href={`#${annotationAnchorId(id)}`}
                        className="text-accent underline-offset-4 hover:underline"
                      >
                        Note {position + 1}
                      </a>
                    ))}
                    {partial && (
                      <span className="italic">
                        Some of the notes behind this are no longer shared.
                      </span>
                    )}
                  </p>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
