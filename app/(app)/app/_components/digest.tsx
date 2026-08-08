"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { GOLD_PAIRS } from "@/lib/digest/engine";
import { relativeWhen } from "@/lib/sessions-ui";
import { errorClass, eyebrowClass } from "@/lib/ui";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { readableError } from "./errors";

type Digest = FunctionReturnType<typeof api.digests.listMine>[number];
type DigestItem = Digest["items"][number];

/**
 * A digest is one person's mail.
 *
 * `digests.listMine` starts at the signed-in user's id, so there is no argument
 * that could return somebody else's — and this component is the only thing that
 * renders one. Nothing aggregates digests, nothing compares them, and there is
 * no view anywhere that says who has read theirs. The line saying so is on the
 * screen because a promise the product keeps silently is a promise nobody
 * knows about.
 *
 * ## Two kinds of line, drawn differently
 *
 * The `digest_gold5` policy makes exactly two shapes (see
 * `lib/digest/engine.ts`): a **collision**, where somebody landed on a passage
 * the recipient themselves annotated and the two types make one of the five
 * gold pairs — and a **coalesced** line, which is everything else on a paper
 * summed into a sentence. The first is the reason the digest exists; the second
 * is context. They are drawn to say that: a collision carries a rule and the
 * name of the pair, a coalesced line is a quiet bullet.
 */
const BOUNDARY_LABEL: Record<Digest["boundary"], string> = {
  "session-prep": "Before the session",
  "session-start": "As the session started",
  "since-away": "Since you were away",
};

/**
 * The prep digest for one session — the personal half of a session page.
 *
 * Renders nothing at all when the boundary hasn't fired: a session scheduled
 * for next week has no prep yet, and an empty "Your prep" heading over a blank
 * box is worse than the absence of one.
 */
export function SessionDigest({
  labId,
  sessionId,
}: {
  labId: Id<"labs">;
  sessionId: Id<"sessions">;
}) {
  const digests = useQuery(api.digests.listMine, { labId });
  const mine = (digests ?? []).filter(
    (digest) => digest.sessionId === sessionId,
  );

  if (mine.length === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className={eyebrowClass}>Your prep</h2>
      <p className="max-w-prose font-sans text-xs text-ink-faint">
        Written for you from what the lab wrote after you last looked. Only you
        see this.
      </p>
      <div className="flex flex-col gap-6">
        {mine.map((digest) => (
          <DigestCard key={digest._id} digest={digest} />
        ))}
      </div>
    </section>
  );
}

/**
 * "Since you were away" on the lab's home page: the digests that have arrived
 * and not been acknowledged, whatever boundary made them.
 *
 * Acknowledged ones drop out rather than greying out. This is an inbox, and an
 * inbox that keeps everything forever is a list nobody opens.
 */
export function DigestInbox({ labId }: { labId: Id<"labs"> }) {
  const digests = useQuery(api.digests.listMine, { labId });
  const unread = (digests ?? []).filter(
    (digest) => digest.acknowledgedAt === undefined,
  );

  if (unread.length === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className={eyebrowClass}>Since you were away</h2>
      <p className="max-w-prose font-sans text-xs text-ink-faint">
        Delivered at a boundary — before a session, and as it starts — never on
        every write. Only you see this.
      </p>
      <div className="flex flex-col gap-6">
        {unread.map((digest) => (
          <DigestCard key={digest._id} digest={digest} />
        ))}
      </div>
    </section>
  );
}

function DigestCard({ digest }: { digest: Digest }) {
  const markDigestSeen = useMutation(api.digests.markDigestSeen);
  const markSeen = useMutation(api.digests.markSeen);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const dropped = digest.droppedCount ?? 0;
  const acknowledged = digest.acknowledgedAt !== undefined;

  return (
    <article className="flex flex-col gap-3 rounded-md border border-rule bg-surface p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-serif text-lg text-ink-strong">
          {BOUNDARY_LABEL[digest.boundary]}
        </h3>
        <span className="font-sans text-xs text-ink-faint">
          {relativeWhen(digest.generatedAt)}
        </span>
      </header>

      <ul className="flex flex-col gap-3">
        {digest.items.map((item, index) => (
          <DigestLine key={`${item.paperId}-${index}`} item={item} />
        ))}
      </ul>

      {dropped > 0 && (
        <p className="font-sans text-xs text-ink-faint tabular-nums">
          +{dropped} more {dropped === 1 ? "annotation" : "annotations"} the cap
          held back.
        </p>
      )}

      {/*
       * The cursor only ever moves because somebody said it should. Margin
       * stores no dwell time and no read receipt, so "caught up" is a button
       * with a person behind it, not a timer that fires when a panel scrolls
       * into view.
       */}
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          disabled={pending || acknowledged}
          className="font-sans text-sm text-accent underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:text-ink-faint disabled:no-underline"
          onClick={async () => {
            setError(null);
            setPending(true);
            try {
              await markDigestSeen({ digestId: digest._id });
              // Advance the cursors this digest was written against, so the
              // next one starts where this one stopped.
              //
              // `digests.markSeen` stamps the cursor with the server's clock,
              // so anything written between `digest.generatedAt` and this
              // click lands behind the cursor and won't appear in the next
              // digest. Closing that gap needs the mutation to accept the
              // digest's boundary instead of `now` — a backend change, and
              // out of scope here. Flagged rather than papered over.
              const papers = [...new Set(digest.items.map((i) => i.paperId))];
              for (const paperId of papers) {
                await markSeen({ paperId });
              }
              if (digest.sessionId !== undefined) {
                await markSeen({ sessionId: digest.sessionId });
              }
            } catch (caught) {
              setError(readableError(caught, "That didn't go through."));
            } finally {
              setPending(false);
            }
          }}
        >
          {acknowledged
            ? "Caught up"
            : pending
              ? "Marking…"
              : "I'm caught up"}
        </button>
      </div>

      {error !== null && (
        <p role="alert" aria-live="polite" className={errorClass}>
          {error}
        </p>
      )}
    </article>
  );
}

function DigestLine({ item }: { item: DigestItem }) {
  const href = `/app/library/${item.paperId}/read`;

  if (item.kind === "collision") {
    const label =
      item.pairType !== undefined ? GOLD_PAIRS[item.pairType] : undefined;
    return (
      <li className="border-l-2 border-accent-strong pl-3">
        {label !== undefined && (
          <span className="font-sans text-[10px] uppercase tracking-[0.14em] text-accent-strong">
            {label}
          </span>
        )}
        <p className="font-serif text-base leading-relaxed text-ink">
          {item.line}
        </p>
        <Link
          href={href}
          className="font-sans text-xs text-accent underline-offset-4 hover:underline"
        >
          Read the passage
        </Link>
      </li>
    );
  }

  return (
    <li className="flex gap-2.5 pl-0.5">
      <span aria-hidden="true" className="font-sans text-ink-faint">
        ·
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="font-serif text-base leading-relaxed text-ink-muted">
          {item.line}
        </span>
        <Link
          href={href}
          className="self-start font-sans text-xs text-ink-faint underline-offset-4 hover:text-accent hover:underline"
        >
          In the margin
        </Link>
      </span>
    </li>
  );
}
