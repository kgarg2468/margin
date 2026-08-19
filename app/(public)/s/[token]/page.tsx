import { fetchMutation } from "convex/nextjs";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { SharedPaper } from "./_components/shared-paper";
import { SharedSynthesis } from "./_components/shared-synthesis";

/**
 * Read fresh on every request, always.
 *
 * This is the load-bearing line of the file. `shares.view` re-checks the whole
 * consent story on each call — link not revoked, artifact still there, each
 * note still lab-visible and its author still opted in, sign-off still
 * standing — and every one of those can change after the link was sent. A
 * cached render is a copy of an answer that was true once, served by a machine
 * that has not been told it stopped being true, which is precisely the failure
 * revocation-on-read exists to rule out.
 */
export const dynamic = "force-dynamic";

/**
 * Nothing about the artifact, on purpose.
 *
 * A title here would travel: into a chat client's link preview, a crawler's
 * index, a browser's history synced across a stranger's devices. The lab
 * agreed to show the paper to whoever opens the link, which is not the same as
 * agreeing to have its title rendered by every service the link passes
 * through on the way. Somebody who opens it sees everything; the pipes see a
 * word.
 */
export const metadata: Metadata = {
  title: "Shared on margin",
  robots: { index: false, follow: false, nocache: true },
};

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // One answer for a token that never existed, a link taken down, a paper
  // deleted under it, and a sign-off withdrawn since. `notFound()` for all of
  // them, so what a prober learns from a dead link is nothing.
  //
  // A mutation, because the read is rate-limited and a Convex query cannot
  // write the counter — see `shares.view`. Nothing about the reader is
  // recorded; what it writes is a per-link window.
  const shared = await fetchMutation(api.shares.view, { token });
  if (shared === null) {
    notFound();
  }
  if ("busy" in shared) {
    return <Busy />;
  }

  return shared.kind === "paper" ? (
    <SharedPaper token={token} shared={shared} />
  ) : (
    <SharedSynthesis shared={shared} />
  );
}

/**
 * The link is good and the moment is not.
 *
 * Deliberately not a 404. A reader whose link is fine should not be told it
 * has been taken down — they would believe it and stop, and there would be no
 * way back from a wrong answer given once. This says what is true: come back
 * in a moment.
 */
function Busy() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-prose flex-col justify-center gap-3 px-6">
      <h1 className="font-serif text-xl text-ink-strong">
        This link is busy right now.
      </h1>
      <p className="font-serif text-base leading-relaxed text-ink-muted">
        A lot of people are reading it at once. Give it a minute and reload —
        the link itself is fine.
      </p>
    </main>
  );
}
