"use client";

import type { Id } from "@/convex/_generated/dataModel";
import { use } from "react";
import { Reader } from "./_components/reader";

/**
 * The reading surface.
 *
 * `?session=` is what tells the reader it arrived from a journal-club context,
 * which is the whole of the difference: the privacy constitution defaults an
 * annotation to lab-visible inside a session (prep is collaborative by
 * definition) and to private outside one. The reader shows which default is in
 * force rather than applying it quietly.
 */
export default function ReadPage({
  params,
  searchParams,
}: {
  params: Promise<{ paperId: string }>;
  searchParams: Promise<{ session?: string }>;
}) {
  const { paperId } = use(params);
  const { session } = use(searchParams);

  return (
    <Reader
      paperId={paperId as Id<"papers">}
      sessionId={
        session === undefined || session.length === 0
          ? undefined
          : (session as Id<"sessions">)
      }
    />
  );
}
