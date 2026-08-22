"use client";

import { api } from "@/convex/_generated/api";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import type { FunctionReturnType } from "convex/server";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { consumeSharedPaper } from "@/lib/shares/pending-import";
import { isPermanentInviteRefusal, readableError } from "./errors";
import type { ImportedPaper } from "./landing";

export type LabSummary = FunctionReturnType<typeof api.labs.getMyLabs>[number];

/**
 * What became of an invite code that arrived in the URL, once we know.
 *
 * `retryCode` is set only when the attempt failed for a reason that might not
 * still be true in ten seconds — the code itself is still good, and it is
 * still in the address bar waiting to be spent.
 */
type InviteNoticeState = {
  tone: "joined" | "refused";
  message: string;
  retryCode?: string;
};

/**
 * What became of the share link somebody arrived on, if they arrived on one.
 *
 * Three states rather than two, because "nothing to wait for" and "not asked
 * yet" are the difference between a landing that works and one that races. The
 * redirect at `/app` fires the moment the lab list arrives, which can easily be
 * before a redemption has come back — so it has to be able to tell an arrival
 * with no pending link, which it may land immediately, from one whose paper is
 * still on its way, which it must wait for.
 *
 * `settled` carries `null` for every way a redemption can come to nothing: no
 * token in this tab, a link revoked while the reader was signing up, a paper
 * deleted under it, a lab gone. The reader is simply where they would have been
 * anyway. See `shares.importFromShare` for why none of those is worth an error
 * screen in somebody's first five minutes.
 */
type SharedImport =
  | { kind: "unasked" }
  | { kind: "running" }
  | { kind: "settled"; paper: (ImportedPaper & { labId: string }) | null };

type LabContextValue = {
  /** `undefined` while the first query is in flight. */
  labs: LabSummary[] | undefined;
  currentLab: LabSummary | null;
  selectLab: (labId: LabSummary["_id"]) => void;
  /** The outcome of an emailed invitation, until it is dismissed. */
  inviteNotice: InviteNoticeState | null;
  dismissInviteNotice: () => void;
  /** Present only while a failed-but-retryable invitation is on the notice. */
  retryInviteNotice: () => void;
  /**
   * Whether this arrival has finished asking for a personal library. False
   * means "no labs yet" is not yet an answer about this account, only about
   * this instant, and nothing should be drawn that depends on the difference.
   */
  libraryChecked: boolean;
  /** Whether that ask is what brought the library into being, just now. */
  libraryJustCreated: boolean;
  /**
   * Spend that signal. Called by the one redirect that honours it, because this
   * provider lives in the layout and outlives the page: left standing, the flag
   * would send a member who has come back to `/app` to `?add=1` again and
   * reopen the panel they closed.
   */
  spendLibraryJustCreated: () => void;
  /**
   * The paper a share link brought in, and whether it is still coming.
   *
   * Reported rather than acted on, exactly as `libraryJustCreated` is and for
   * the same reason: `/app` owns the one redirect an arrival gets, and a second
   * `router.replace` racing it is how a destination gets dropped.
   */
  sharedImport: SharedImport;
};

const LabContext = createContext<LabContextValue | null>(null);

const STORAGE_KEY = "margin.currentLabId";

/** The shape `convex/invites.ts` mints; anything else in the URL is not a code. */
const INVITE_PATTERN = /^[A-Za-z0-9]{1,16}$/;

/**
 * Spend the code out of the address bar.
 *
 * Called only once the server has actually accepted it — or has refused it in
 * terms that will not change. Removing it any earlier throws away a live
 * invitation: a dropped connection or a mutation that lost an OCC race would
 * leave the recipient on a URL that no longer says what they were invited to,
 * with the code now only recoverable from the original email.
 *
 * Checks that the code is still the one in the bar before deleting, so a
 * response that lands after the reader has navigated somewhere else doesn't
 * rewrite a URL it has nothing to do with.
 */
function clearInviteParam(code: string): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get("invite") !== code) {
    return;
  }
  url.searchParams.delete("invite");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

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
  const ensureMyLibrary = useMutation(api.labs.ensureMyLibrary);
  const importFromShare = useMutation(api.shares.importFromShare);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inviteNotice, setInviteNotice] = useState<InviteNoticeState | null>(
    null,
  );
  /**
   * Whether the library question has been put and answered, either way.
   *
   * The invite below waits on this, and the wait is the point: both writes are
   * about the same empty account, and `ensureMyLibrary` only provisions for
   * somebody who belongs to no lab at all. Redeeming first would make that false
   * before it was asked, so whether a newcomer arriving on an invitation also
   * got a personal library would come down to which round trip landed first.
   * They get both, always, which is the decision this PR documents.
   */
  const [libraryChecked, setLibraryChecked] = useState(false);
  /**
   * Whether the library on the shelf was minted by *this* arrival.
   *
   * Reported rather than acted on. `/app` already owns the one redirect a solo
   * library gets, and this only changes where that redirect points — a second
   * `router.replace` racing the first is how `?add=1` would get dropped by the
   * one navigation that is supposed to carry it.
   */
  const [libraryJustCreated, setLibraryJustCreated] = useState(false);
  const [sharedImport, setSharedImport] = useState<SharedImport>({
    kind: "unasked",
  });

  useEffect(() => {
    setSelectedId(window.localStorage.getItem(STORAGE_KEY));
  }, []);

  const selectLab = useCallback((labId: LabSummary["_id"]) => {
    setSelectedId(labId);
    window.localStorage.setItem(STORAGE_KEY, labId);
  }, []);

  const dismissInviteNotice = useCallback(() => setInviteNotice(null), []);

  const spendLibraryJustCreated = useCallback(
    () => setLibraryJustCreated(false),
    [],
  );

  /**
   * Try to spend one invite code, and say what happened.
   *
   * The two ways this fails are not the same failure, and conflating them is
   * what made the first version lose invitations. Only a refusal the server
   * explicitly labels as being about the *code* — revoked, expired, full, not
   * a code at all — is final, and only that spends it out of the URL.
   *
   * Everything else is weather: a dropped connection, a 5xx, a transaction
   * that lost its race, and in particular an authorization helper saying the
   * caller isn't signed in, which is a fact about the session and not about
   * the invitation. The code stays in the address bar, so a retry — or simply
   * a reload, which sends an unauthenticated reader back through `/signin`
   * carrying it — picks the invitation back up.
   */
  const attemptRedeem = useCallback(
    async (code: string) => {
      setInviteNotice(null);
      try {
        const { labId, labName, alreadyMember } = await redeemInvite({ code });
        clearInviteParam(code);
        selectLab(labId);
        setInviteNotice({
          tone: "joined",
          message: alreadyMember
            ? `You're already in ${labName}.`
            : `You've joined ${labName}.`,
        });
      } catch (caught) {
        if (isPermanentInviteRefusal(caught)) {
          clearInviteParam(code);
          setInviteNotice({
            tone: "refused",
            message: readableError(
              caught,
              "That invitation is no longer valid. Ask whoever sent it for a new one.",
            ),
          });
          return;
        }
        setInviteNotice({
          tone: "refused",
          message:
            "We couldn't accept that invitation just now — your session may have lapsed. It's still good: try again, or reload to sign in.",
          retryCode: code,
        });
      }
    },
    [redeemInvite, selectLab],
  );

  /**
   * Ask, once, for somewhere to put a paper — and go there if it was just made.
   *
   * This is where a personal library is minted, rather than in the auth callback
   * that created the account: requesting an emailed sign-in link creates the
   * user row before the mail is sent, so provisioning from there ran for
   * addresses nobody had proven they could read. `labs.ensureMyLibrary` needs a
   * session, and this is the first render that has one.
   *
   * `created` is also the only trustworthy answer to "was this account new?".
   * The sign-in form used to decide that from which tab was showing, which is a
   * fact about the UI and not about the account — wrong for every first-time
   * Google and sign-in-link user, who never see that tab. The server knows; ask
   * the server.
   *
   * Nothing here is retried and a failure is swallowed on purpose. The next
   * navigation inside `/app` remounts nothing — this provider lives in the
   * layout — but the next visit asks again, and until then the honest outcome is
   * the onboarding screen `/app` already knows how to show.
   */
  const askedForLibrary = useRef(false);

  useEffect(() => {
    if (askedForLibrary.current) {
      return;
    }
    askedForLibrary.current = true;
    void ensureMyLibrary({})
      .then((outcome) => {
        if (outcome !== null && outcome.created) {
          setLibraryJustCreated(true);
        }
      })
      .catch(() => {
        // Swallowed deliberately — see above. A newcomer with no library sees
        // the onboarding screen, which is the truth about their account.
      })
      .finally(() => setLibraryChecked(true));
  }, [ensureMyLibrary]);

  /**
   * Take the token out of the tab now, redeem it once the library exists.
   *
   * Split in two, and both halves are load-bearing.
   *
   * The *taking* happens on mount, before anything has been asked of the
   * server. It has to: `/app` waits on this answer before it redirects, and a
   * question that could not be answered until a round trip came back would put
   * a skeleton in front of every ordinary arrival for the length of one. Read
   * on the first commit, it is settled long before the lab list is. Taking also
   * clears storage at the earliest possible moment — after this the token lives
   * in one closure and nowhere a later navigation could find it.
   *
   * The *redeeming* waits for `libraryChecked`, which is not politeness either.
   * `shares.importFromShare` writes into the caller's personal library and does
   * nothing at all if they have not got one, so redeeming before
   * `ensureMyLibrary` has answered would make whether a new account keeps the
   * paper it signed up for a matter of which round trip landed first.
   *
   * A failure is swallowed and reported as nothing imported. That is the same
   * answer a revoked link gets, deliberately: the reader is one press of Back
   * from the page the link is still on, and the alternative is an error about
   * somebody else's lab on the first screen of their account.
   */
  const pendingShareToken = useRef<string | null>(null);
  const tookShareToken = useRef(false);
  useEffect(() => {
    if (tookShareToken.current) {
      return;
    }
    tookShareToken.current = true;
    const token = consumeSharedPaper(() => window.sessionStorage);
    pendingShareToken.current = token;
    if (token === null) {
      setSharedImport({ kind: "settled", paper: null });
    }
  }, []);

  const redeemedShare = useRef(false);
  useEffect(() => {
    const token = pendingShareToken.current;
    if (!libraryChecked || token === null || redeemedShare.current) {
      return;
    }
    redeemedShare.current = true;
    setSharedImport({ kind: "running" });
    void importFromShare({ token })
      .then((paper) => {
        setSharedImport({ kind: "settled", paper });
      })
      .catch(() => {
        setSharedImport({ kind: "settled", paper: null });
      });
  }, [libraryChecked, importFromShare]);

  // One attempt per code per mount. Without this, StrictMode's double-invoke
  // in development fires two redemptions for the same code; the mutation is
  // idempotent per member so nothing breaks, but there is no reason to ask
  // twice. The retry button calls `attemptRedeem` directly and is not gated.
  const attempted = useRef<string | null>(null);

  useEffect(() => {
    // Ordering, not politeness. See `libraryChecked`.
    if (!libraryChecked) {
      return;
    }
    // Read from the URL directly rather than through `useSearchParams`: this
    // runs once on mount and the hook would opt the whole shell out of static
    // rendering to answer a question we only ask in the browser anyway.
    const code = new URL(window.location.href).searchParams.get("invite");
    if (code === null || !INVITE_PATTERN.test(code)) {
      return;
    }
    if (attempted.current === code) {
      return;
    }
    attempted.current = code;
    void attemptRedeem(code);
  }, [attemptRedeem, libraryChecked]);

  const retryCode = inviteNotice?.retryCode;
  const retryInviteNotice = useCallback(() => {
    if (retryCode !== undefined) {
      void attemptRedeem(retryCode);
    }
  }, [retryCode, attemptRedeem]);

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
        retryInviteNotice,
        libraryChecked,
        libraryJustCreated,
        spendLibraryJustCreated,
        sharedImport,
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
  const { inviteNotice, dismissInviteNotice, retryInviteNotice } = useLabs();
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
      <span className="flex items-baseline gap-4">
        {inviteNotice.retryCode !== undefined && (
          <button
            type="button"
            onClick={retryInviteNotice}
            className="tap-target font-sans text-xs uppercase tracking-[0.14em] text-accent transition-colors hover:text-accent-strong"
          >
            Try again
          </button>
        )}
        <button
          type="button"
          onClick={dismissInviteNotice}
          className="tap-target font-sans text-xs uppercase tracking-[0.14em] text-ink-faint transition-colors hover:text-ink"
        >
          Dismiss
        </button>
      </span>
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
