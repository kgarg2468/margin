"use client";

import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { useCallback, useState } from "react";
import { ConfirmAction } from "@/app/(app)/app/_components/confirm-action";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { sharePath } from "@/lib/shares/token";
import {
  eyebrowClass,
  linkButtonClass,
  secondaryButtonClass,
  skeletonClass,
} from "@/lib/ui";

/**
 * The lab's view of a link it has published.
 *
 * Two controls that look adjacent and are not the same kind of thing, which is
 * the whole design problem here. One mints or takes down a link — an act about
 * the *paper*, and any member may perform it. The other is each member's own
 * answer about their own notes, and nobody else's to give: creating a link
 * publishes the sharer's notes and nobody else's, and every other member's
 * writing stays out of it until they say otherwise, here, themselves.
 *
 * Every member sees the link, not just its creator. A member whose notes could
 * end up on the other end of a URL is owed the knowledge that the URL exists —
 * that is what makes the opt-in a real choice rather than a setting nobody
 * knew to look for.
 */
export function SharePanel({ paperId }: { paperId: Id<"papers"> }) {
  const state = useQuery(api.shares.forPaper, { paperId });
  const create = useMutation(api.shares.sharePaper);
  const revoke = useMutation(api.shares.revoke);
  const setOptIn = useMutation(api.shares.setPaperOptIn);
  const [working, setWorking] = useState(false);

  const mint = useCallback(async () => {
    setWorking(true);
    try {
      await create({ paperId });
    } finally {
      setWorking(false);
    }
  }, [create, paperId]);

  if (state === undefined) {
    return (
      <section className="flex flex-col gap-4">
        <h2 className={eyebrowClass}>Sharing</h2>
        <div className={`${skeletonClass} h-24 w-full`} />
      </section>
    );
  }

  const { share } = state;

  return (
    <section className="flex flex-col gap-4">
      <h2 className={eyebrowClass}>Sharing</h2>

      {share === null ? (
        <div className="flex flex-col gap-3">
          <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
            A read-only link opens this paper with the margin beside it, for
            anyone you send it to. It is unlisted, it is not indexed, and it
            carries your notes and nobody else&rsquo;s until they say so
            themselves.
          </p>
          <button
            type="button"
            onClick={() => void mint()}
            disabled={working}
            className={`${secondaryButtonClass} self-start`}
          >
            Create a link
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <LinkRow token={share.token} />
          <p className="font-sans text-xs text-ink-faint">
            Created by {share.createdByName} ·{" "}
            {state.optedInCount === 1
              ? "1 member has shared their notes"
              : `${state.optedInCount} members have shared their notes`}
          </p>
          {share.canRevoke ? (
            <ConfirmAction
              label="Revoke this link"
              confirmLabel="Revoke — the link stops working"
              tone="faint"
              size="xs"
              run={async () => {
                await revoke({ shareId: share._id });
              }}
            />
          ) : (
            <p className="font-sans text-xs text-ink-faint">
              Only {share.createdByName} or the PI can take this down.
            </p>
          )}
        </div>
      )}

      {/* Shown whether or not a link exists yet. A member who has already said
          yes should be able to see that they did — and change it — without
          waiting for somebody else to create the link that would act on it. */}
      <div className="flex flex-col gap-1.5 border-t border-rule pt-4">
        <label className="flex items-baseline gap-2.5">
          <input
            type="checkbox"
            checked={state.optedIn}
            onChange={(event) =>
              void setOptIn({ paperId, included: event.target.checked })
            }
            className="accent-accent"
          />
          <span className="font-serif text-sm leading-relaxed text-ink">
            Include my notes on this paper in shared links
          </span>
        </label>
        <p className="max-w-prose pl-6 font-sans text-xs leading-relaxed text-ink-faint">
          Only notes you marked visible to the lab — anything private stays
          private. Unticking removes yours from the link on the next load, with
          nothing left in their place; replies your colleagues wrote under them
          are their own and stay, on their own.
        </p>
      </div>
    </section>
  );
}

/**
 * The URL, and one button that puts it on the clipboard.
 *
 * Rendered as text a person can select as well, because the clipboard write
 * can fail — an insecure origin, a browser that wants a user gesture it
 * did not see — and the fallback for "copy didn't work" should be the link
 * itself rather than a dead end.
 */
function LinkRow({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  const url =
    typeof window === "undefined"
      ? sharePath(token)
      : `${window.location.origin}${sharePath(token)}`;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <code className="min-w-0 flex-1 truncate rounded-sm border border-rule bg-surface-sunken px-2.5 py-1.5 font-mono text-xs text-ink-muted">
        {url}
      </code>
      <button
        type="button"
        className={linkButtonClass}
        onClick={() => {
          void navigator.clipboard
            .writeText(url)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
