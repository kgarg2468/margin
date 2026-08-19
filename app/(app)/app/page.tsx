"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LabOverview } from "./_components/lab-overview";
import { landOnShelf } from "./_components/landing";
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

  useEffect(() => {
    if (redirected.current || !soloLibrary) {
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
    // Where to go, and the signal to leave behind — see `landOnShelf`. That the
    // server decides whether this account is new, rather than which tab of the
    // sign-in form was showing, is what makes it right for the Google and
    // sign-in-link doors too; that the answer is spent here is what stops it
    // reopening the panel on a later visit to this page.
    const { destination, justCreatedAfter } = landOnShelf(libraryJustCreated);
    if (libraryJustCreated && !justCreatedAfter) {
      spendLibraryJustCreated();
    }
    // `replace`, not `push`: this is a redirect and not a step, so Back from the
    // library goes where the reader actually came from rather than to a page
    // whose only behaviour is to bounce them here again.
    router.replace(destination);
  }, [soloLibrary, libraryJustCreated, spendLibraryJustCreated, router]);

  if (labs === undefined || redirecting) {
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
