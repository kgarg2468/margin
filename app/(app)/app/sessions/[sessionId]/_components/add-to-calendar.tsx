"use client";

import { buildIcsCalendar } from "@/lib/ics/ics";
import type { SessionDetail } from "./manage";

export function AddToCalendar({ session }: { session: SessionDetail }) {
  const title = session.title ?? session.paperTitle ?? "Journal club session";

  function downloadCalendar() {
    const origin = window.location.origin.replace(/\/$/, "");
    const sessionUrl = `${origin}/app/sessions/${session._id}`;
    const calendar = buildIcsCalendar({
      uid: `${session._id}@margin`,
      title,
      description: `Paper: ${session.paperTitle ?? title}\nSession: ${sessionUrl}`,
      startMs: session.scheduledAt,
      durationMinutes: 60,
      url: sessionUrl,
    });
    const blobUrl = URL.createObjectURL(
      new Blob([calendar], { type: "text/calendar;charset=utf-8" }),
    );
    const link = document.createElement("a");
    const filename =
      title.trim().replace(/[\\/:*?"<>|]/g, "-") || "journal-club-session";

    link.href = blobUrl;
    link.download = `${filename}.ics`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }

  return (
    <button
      type="button"
      onClick={downloadCalendar}
      className="self-start font-sans text-sm text-ink-faint underline-offset-4 hover:text-accent hover:underline"
    >
      Add to calendar (.ics)
    </button>
  );
}
