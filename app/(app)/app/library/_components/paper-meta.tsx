import type { api } from "@/convex/_generated/api";
import { chipClass } from "@/lib/ui";
import type { FunctionReturnType } from "convex/server";

export type PaperSummary = FunctionReturnType<
  typeof api.papers.listPapers
>[number];

export type IngestStatus = PaperSummary["ingestStatus"];

/**
 * The line under a title, the way a bibliography would set it: who, when,
 * where. Long author lists get the `et al.` a citation would give them —
 * eleven names in a list view is noise, and the full list is on the paper.
 */
export function byline({
  authors,
  year,
  venue,
}: {
  authors?: string[];
  year?: number;
  venue?: string;
}): string {
  const parts: string[] = [];

  if (authors !== undefined && authors.length > 0) {
    parts.push(
      authors.length > 3
        ? `${authors.slice(0, 3).join(", ")} et al.`
        : authors.join(", "),
    );
  }
  if (year !== undefined) {
    parts.push(String(year));
  }
  if (venue !== undefined) {
    parts.push(venue);
  }

  return parts.join(" · ");
}

/**
 * Only the states a member can do something about get a chip. `ready` is the
 * expected case and says nothing — a library where every row is labelled is a
 * library where no label is read.
 */
export function StatusChip({ status }: { status: IngestStatus }) {
  if (status === "ready") {
    return null;
  }

  const label =
    status === "needs-pdf"
      ? "PDF needed"
      : status === "failed"
        ? "Ingest failed"
        : "Text pending";

  return <span className={chipClass}>{label}</span>;
}
