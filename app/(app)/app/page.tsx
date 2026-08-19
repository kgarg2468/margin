"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LabOverview } from "./_components/lab-overview";
import { useLabs } from "./_components/lab-provider";
import { Onboarding } from "./_components/onboarding";
import { PageSkeleton } from "./_components/skeletons";

export default function AppHome() {
  const { labs, currentLab, libraryChecked, libraryJustCreated } = useLabs();
  const router = useRouter();
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
    if (!soloLibrary) {
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
    setRedirecting(true);
    // `replace`, not `push`: this is a redirect and not a step, so Back from the
    // library goes where the reader actually came from rather than to a page
    // whose only behaviour is to bounce them here again.
    //
    // `?add=1` only when this arrival is what created the library. Signing up is
    // an errand — somebody has a paper they want to read — so the panel is open
    // once, on the one visit where there is nothing else to have come for. Every
    // later visit lands on the shelf, which by then has papers on it. That the
    // server decides this, rather than which tab of the sign-in form was
    // showing, is what makes it right for the Google and sign-in-link doors too.
    router.replace(
      libraryJustCreated ? "/app/library?add=1" : "/app/library",
    );
  }, [soloLibrary, libraryJustCreated, router]);

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
