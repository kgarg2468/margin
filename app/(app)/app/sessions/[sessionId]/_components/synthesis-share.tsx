"use client";

import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { useCallback, useState } from "react";
import { ConfirmAction } from "@/app/(app)/app/_components/confirm-action";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { sharePath } from "@/lib/shares/token";
import { linkButtonClass } from "@/lib/ui";

/**
 * A link to the write-up the lab signed.
 *
 * The sign-off *is* the consent here, which is what makes this a much smaller
 * control than the paper's. There is no per-author opt-in to collect, because
 * what travels is not a column of people's marginalia — it is one document
 * that somebody with the authority to speak for the lab read, edited, and put
 * the lab's name on. Minting the link is the same kind of act as approving the
 * copy, so it asks for the same permission: the presenter, or the PI.
 *
 * `staleWarning` is the one thing this component knows that the backend also
 * knows, and it is here to explain a link that has already gone quiet rather
 * than to decide anything. When a cited note is withdrawn, `shares.view`
 * returns nothing and the page 404s — the signature was checked against a
 * margin that has since changed, and out there is nobody to read a banner or
 * ask about a struck line. Re-approving brings the same link back by itself.
 */
export function SynthesisShare({
  sessionId,
  stale,
}: {
  sessionId: Id<"sessions">;
  stale: boolean;
}) {
  const state = useQuery(api.shares.forSession, { sessionId });
  const create = useMutation(api.shares.shareSynthesis);
  const revoke = useMutation(api.shares.revoke);
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);

  const mint = useCallback(async () => {
    setWorking(true);
    try {
      await create({ sessionId });
    } finally {
      setWorking(false);
    }
  }, [create, sessionId]);

  if (state === undefined) return null;

  const { share } = state;

  // `approved` now means *publishable* rather than merely signed, so it goes
  // false while a note the copy cites is withdrawn. Hiding the whole panel on
  // that would take away the one sentence explaining why an existing link has
  // stopped opening, at exactly the moment somebody needs it. No write-up to
  // share and nothing shared already is the only case with nothing to say.
  if (share === null && !state.approved) return null;

  if (share === null) {
    if (!state.canShare) return null;
    return (
      <button
        type="button"
        onClick={() => void mint()}
        disabled={working}
        className={linkButtonClass}
      >
        Share a read-only link
      </button>
    );
  }

  const url =
    typeof window === "undefined"
      ? sharePath(share.token)
      : `${window.location.origin}${sharePath(share.token)}`;

  return (
    <div className="flex flex-col gap-2 border-t border-rule pt-3">
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
        {share.canRevoke && (
          <ConfirmAction
            label="Revoke"
            confirmLabel="Revoke — the link stops working"
            tone="faint"
            size="xs"
            run={async () => {
              await revoke({ shareId: share._id });
            }}
          />
        )}
      </div>

      <p className="max-w-prose font-sans text-xs leading-relaxed text-ink-faint">
        {stale
          ? "This link is not opening for anyone while a note the write-up was checked against is withdrawn. Approve the copy again and it works from that moment."
          : "Unlisted and not indexed. It shows this copy — never the draft — and stops the moment it is revoked or the approval is withdrawn."}
      </p>
    </div>
  );
}
