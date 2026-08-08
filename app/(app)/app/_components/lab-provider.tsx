"use client";

import { api } from "@/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { readableError } from "./errors";

export type LabSummary = FunctionReturnType<typeof api.labs.getMyLabs>[number];

/** What became of an invite code that arrived in the URL, once we know. */
type InviteNoticeState = { tone: "joined" | "refused"; message: string };

type LabContextValue = {
  /** `undefined` while the first query is in flight. */
  labs: LabSummary[] | undefined;
  currentLab: LabSummary | null;
  selectLab: (labId: LabSummary["_id"]) => void;
  /** The outcome of an emailed invitation, until it is dismissed. */
  inviteNotice: InviteNoticeState | null;
  dismissInviteNotice: () => void;
};

const LabContext = createContext<LabContextValue | null>(null);

const STORAGE_KEY = "margin.currentLabId";

/** The shape `convex/invites.ts` mints; anything else in the URL is not a code. */
const INVITE_PATTERN = /^[A-Za-z0-9]{1,16}$/;

/**
 * Which lab you are looking at is a client-side concern for now — one route
 * (`/app`) renders whichever lab is selected. It is remembered across reloads
 * so a two-lab postdoc doesn't have to re-pick every morning. When the reader
 * and sessions arrive this becomes a real route segment.
 *
 * It is also where an emailed invitation finishes. The link in the mail is
 * `/app?invite=CODE`; by the time anything here renders the recipient has a
 * session (the middleware saw to that, carrying the code through `/signin`),
 * so redeeming it is one mutation. Doing it here rather than on a card means
 * it happens whether the recipient is brand new or already in three labs.
 */
export function LabProvider({ children }: { children: ReactNode }) {
  const labs = useQuery(api.labs.getMyLabs);
  const redeemInvite = useMutation(api.invites.redeemInvite);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inviteNotice, setInviteNotice] = useState<InviteNoticeState | null>(
    null,
  );

  useEffect(() => {
    setSelectedId(window.localStorage.getItem(STORAGE_KEY));
  }, []);

  const selectLab = useCallback((labId: LabSummary["_id"]) => {
    setSelectedId(labId);
    window.localStorage.setItem(STORAGE_KEY, labId);
  }, []);

  const dismissInviteNotice = useCallback(() => setInviteNotice(null), []);

  useEffect(() => {
    // Read from the URL directly rather than through `useSearchParams`: this
    // runs once on mount and the hook would opt the whole shell out of static
    // rendering to answer a question we only ask in the browser anyway.
    const url = new URL(window.location.href);
    const code = url.searchParams.get("invite");
    if (code === null || !INVITE_PATTERN.test(code)) {
      return;
    }

    // Spend the code out of the address bar before spending it at the server,
    // so a refresh mid-flight cannot start a second redemption.
    url.searchParams.delete("invite");
    window.history.replaceState(
      null,
      "",
      url.pathname + url.search + url.hash,
    );

    let live = true;
    void redeemInvite({ code })
      .then(({ labId, labName, alreadyMember }) => {
        if (!live) return;
        selectLab(labId);
        setInviteNotice({
          tone: "joined",
          message: alreadyMember
            ? `You're already in ${labName}.`
            : `You've joined ${labName}.`,
        });
      })
      .catch((caught: unknown) => {
        if (!live) return;
        setInviteNotice({
          tone: "refused",
          message: readableError(
            caught,
            "That invitation is no longer valid. Ask whoever sent it for a new one.",
          ),
        });
      });

    return () => {
      live = false;
    };
  }, [redeemInvite, selectLab]);

  const currentLab =
    labs?.find((lab) => lab._id === selectedId) ?? labs?.[0] ?? null;

  return (
    <LabContext.Provider
      value={{
        labs,
        currentLab,
        selectLab,
        inviteNotice,
        dismissInviteNotice,
      }}
    >
      {children}
    </LabContext.Provider>
  );
}

/**
 * What happened to the invitation you clicked, said once and then got out of
 * the way. A note in the margin of the page, not a toast over it: the same
 * left rule everything else on this screen is hung from.
 *
 * Rendered by both things `/app` can show, because an invitation is just as
 * likely to be redeemed by someone who already has labs as by someone who
 * doesn't.
 */
export function InviteNotice() {
  const { inviteNotice, dismissInviteNotice } = useLabs();
  if (inviteNotice === null) {
    return null;
  }

  return (
    <div
      role="status"
      className={
        "pop-in flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-l-2 pl-4 " +
        (inviteNotice.tone === "joined"
          ? "border-accent"
          : "border-accent-strong")
      }
    >
      <p className="font-serif text-base leading-relaxed text-ink">
        {inviteNotice.message}
      </p>
      <button
        type="button"
        onClick={dismissInviteNotice}
        className="tap-target font-sans text-xs uppercase tracking-[0.14em] text-ink-faint transition-colors hover:text-ink"
      >
        Dismiss
      </button>
    </div>
  );
}

export function useLabs(): LabContextValue {
  const value = useContext(LabContext);
  if (value === null) {
    throw new Error("useLabs must be used inside the /app layout.");
  }
  return value;
}
