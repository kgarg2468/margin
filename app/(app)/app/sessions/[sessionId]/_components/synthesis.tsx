"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { relativeWhen } from "@/lib/sessions-ui";
import {
  errorClass,
  eyebrowClass,
  secondaryButtonClass,
  skeletonClass,
} from "@/lib/ui";
import type { FunctionReturnType } from "convex/server";
import { useAction, useQuery } from "convex/react";
import { useState } from "react";
import { readableError } from "../../../_components/errors";
import { annotationAnchorId } from "./session-board";
import type { SessionDetail } from "./manage";

type Synthesis = NonNullable<
  FunctionReturnType<typeof api.synthesis.getForSession>
>;
type Section = Synthesis["sections"][number];

/**
 * The write-up, and the one button that makes it.
 *
 * Everything on this surface is in the violet the design tokens hold in
 * reserve for a second voice. That is the whole trust posture in a colour: the
 * lab's own writing is espresso, and the machine's re-arrangement of it is
 * visibly not. A reader should never have to ask which of the two they are
 * looking at.
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

  const has = synthesis !== undefined && synthesis !== null;

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2
          style={{ color: "var(--secondary)" }}
          className="font-sans text-xs font-medium uppercase tracking-[0.18em]"
        >
          Write-up
        </h2>
        {has && (
          <span className="font-sans text-xs text-ink-faint">
            {synthesis.model} · {relativeWhen(synthesis.generatedAt)}
          </span>
        )}
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

      {session.canManage && (
        <div className="flex flex-wrap items-center gap-4">
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
                // deployment, nothing shared to quote, a model that declined,
                // a call that timed out, a run already in flight — arrives as
                // a ConvexError carrying the sentence it wants shown. Passing
                // it through is what surfaces each one distinctly; a client-
                // side taxonomy would only be a worse copy of the server's.
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
                ? "Write it again"
                : "Generate write-up"}
          </button>
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
        <p role="alert" aria-live="polite" className={`${errorClass} max-w-prose`}>
          {error}
        </p>
      )}
    </section>
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
