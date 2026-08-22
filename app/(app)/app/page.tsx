"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LabOverview } from "./_components/lab-overview";
import { landOnShelf } from "./_components/landing";
import type { LabSummary } from "./_components/lab-provider";
import { useLabs } from "./_components/lab-provider";
import { Onboarding } from "./_components/onboarding";
import { PageSkeleton } from "./_components/skeletons";

export default function AppHome() {
  const {
    labs,
    currentLab,
    libraryChecked,
    libraryJustCreated,
    spendLibraryJustCreated,
    selectLab,
    sharedImport,
  } = useLabs();
  const router = useRouter();
  /**
   * One redirect per visit to this page.
   *
   * Spending the just-created signal below re-renders the provider, which
   * changes this effect's dependencies and would otherwise run it a second time
   * — sending a `replace` to the plain shelf chasing the one that was already
   * on its way to `?add=1`.
   */
  const redirected = useRef(false);
  /**
   * Set only once the redirect below has actually been asked for, so the
   * skeleton stands in for a navigation that is happening rather than for one
   * that was considered. The distinction matters: the effect declines to
   * redirect while an invitation is in the address bar, and a page that
   * rendered the skeleton on the same condition the effect *tests* would leave
   * an invited newcomer watching a placeholder — with the notice saying whether
   * their invitation worked drawn by the very component being stood in for.
   */
  const [redirecting, setRedirecting] = useState(false);

  /**
   * A personal library has no overview worth showing.
   *
   * This page is a lab's front matter — the roster, the invite codes, the way
   * out of the group — and every one of those is a fact about other people. For
   * somebody whose only lab is the one Margin provisioned for them at signup,
   * all three render as a list of one, a code with nobody to give it to, and a
   * door that refuses to open because a lab cannot lose its last PI. That is
   * the "organisational setup" a first screen should never be. The shelf is.
   *
   * Only while it is their *only* lab. The moment somebody joins a real lab the
   * overview is about somebody, and `/app` goes back to being worth landing on.
   */
  const soloLibrary =
    labs !== undefined && labs.length === 1 && labs[0]?.personal === true;

  /**
   * A paper that came in on a share link, once it is certain there is one or
   * certain there is not.
   *
   * The wait is what makes this safe rather than lucky. A redemption is a round
   * trip and the lab list is another, and the one that lands first is not fixed
   * — so an arrival that redirected on `labs` alone would carry a reader who
   * pressed "Keep the paper" to their shelf, and drop the paper's own
   * destination on the floor a moment later.
   */
  const importPending = sharedImport.kind !== "settled";
  const importedPaper =
    sharedImport.kind === "settled" ? sharedImport.paper : null;

  useEffect(() => {
    if (redirected.current || importPending) {
      return;
    }
    // A paper the reader asked for outranks the solo-library rule and is not
    // limited by it: somebody who already has labs of their own may still press
    // "Keep the paper" on a share page, and the paper still lands in their own
    // library.
    if (!soloLibrary && importedPaper === null) {
      return;
    }
    // Never out from under an invitation. `/app?invite=CODE` is where an emailed
    // invite is spent, and the code stays in the address bar until
    // `LabProvider` has actually redeemed it — a redirect that fired first would
    // carry the reader to a page the code is not on, and the only remaining copy
    // of it would be in the original email. An invited newcomer is momentarily a
    // solo-library user, which is precisely when this would have gone wrong.
    // Redemption gives them a second lab, so this stops being true by itself.
    if (new URL(window.location.href).searchParams.has("invite")) {
      return;
    }
    redirected.current = true;
    setRedirecting(true);
    // An imported paper lands in the reader's *personal* library, which need
    // not be the lab the shell was last left showing. Switched before the
    // navigation rather than after, so the shelf the reader arrives on is the
    // one the paper is actually on.
    if (importedPaper !== null) {
      selectLab(importedPaper.labId as LabSummary["_id"]);
    }
    // Where to go, and the signal to leave behind — see `landOnShelf`. That the
    // server decides whether this account is new, rather than which tab of the
    // sign-in form was showing, is what makes it right for the Google and
    // sign-in-link doors too; that the answer is spent here is what stops it
    // reopening the panel on a later visit to this page.
    const { destination, justCreatedAfter } = landOnShelf(
      libraryJustCreated,
      importedPaper,
    );
    if (libraryJustCreated && !justCreatedAfter) {
      spendLibraryJustCreated();
    }
    // `replace`, not `push`: this is a redirect and not a step, so Back from the
    // library goes where the reader actually came from rather than to a page
    // whose only behaviour is to bounce them here again.
    router.replace(destination);
  }, [
    soloLibrary,
    importPending,
    importedPaper,
    libraryJustCreated,
    spendLibraryJustCreated,
    selectLab,
    router,
  ]);

  // `importPending` is here as well as in the effect, unlike the invitation
  // check below it, and the difference is that this one always ends: both
  // outcomes of a redemption settle it. What it buys is the flash it prevents —
  // a reader who pressed "Keep the paper" would otherwise watch their lab's
  // front matter draw itself for one round trip before being carried off it.
  if (labs === undefined || redirecting || importPending) {
    return <PageSkeleton />;
  }

  // "No labs" is not an answer about this account until the provisioning ask has
  // come back — before that it is only an answer about this millisecond, and
  // drawing the onboarding screen on it would flash "you aren't in a lab yet" at
  // exactly the person about to be given one.
  if (labs.length === 0 && !libraryChecked) {
    return <PageSkeleton />;
  }

  if (labs.length === 0 || currentLab === null) {
    return <Onboarding />;
  }

  return <LabOverview lab={currentLab} />;
}
