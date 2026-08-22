import { fetchQuery } from "convex/nextjs";
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
  // A plain query, with nothing caught around it. It was briefly a mutation so
  // a rate counter could be written here, and a render is the wrong place for
  // a write: Next may restart, abandon or prefetch this render, and each of
  // those would have spent the counter on a page nobody received. Convex
  // caches this query's answer until the data under it changes, which is the
  // guard the page actually needed. A genuine failure now surfaces as one
  // rather than being dressed up as "come back later" forever.
  const shared = await fetchQuery(api.shares.view, { token });
  if (shared === null) {
    notFound();
  }

  return shared.kind === "paper" ? (
    <SharedPaper token={token} shared={shared} />
  ) : (
    <SharedSynthesis shared={shared} />
  );
}
