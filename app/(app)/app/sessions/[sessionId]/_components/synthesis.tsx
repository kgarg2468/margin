"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { relativeWhen } from "@/lib/sessions-ui";
import { errorClass, eyebrowClass, secondaryButtonClass } from "@/lib/ui";
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
 * annotations this client can *currently* see, and an item whose evidence has
 * gone says so rather than quietly keeping a name attached to a note the reader
 * is no longer allowed to read.
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
        <p className="font-sans text-sm text-ink-faint">Loading…</p>
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
          return (
            <li
              key={`${section.key}-${index}`}
              style={{ borderLeftColor: "var(--secondary)" }}
              className="border-l-2 pl-3.5"
            >
              <p className="max-w-prose font-serif text-base leading-relaxed text-ink">
                {item.text}
              </p>
              <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-sans text-xs text-ink-faint">
                {item.attribution.length > 0 && (
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
                {withdrawn && (
                  <span className="italic">
                    The notes behind this are no longer shared.
                  </span>
                )}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
