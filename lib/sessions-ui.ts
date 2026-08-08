/**
 * The calendar, in words a person reads.
 *
 * Sessions are stored as one number — epoch milliseconds — and every screen
 * that shows one has to answer the same three questions: what day, what time,
 * and how far away. Doing that in each component is how "Feb 12" and
 * "February 12" end up on the same page, so it happens here.
 *
 * The locale is pinned to `en-US` for the same reason `library/[paperId]`
 * pins it: `undefined` means "ask the runtime", and the runtimes disagree.
 * Time *zone* is deliberately not pinned — a meeting happens where the reader
 * is, and every one of these screens renders from a Convex subscription that
 * has no data during SSR, so there is no server render to mismatch with.
 */

const DAY = 24 * 60 * 60 * 1000;

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

const dateWithYearFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const timeFormat = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

const fullFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const relativeFormat = new Intl.RelativeTimeFormat("en-US", {
  numeric: "auto",
});

/** "Feb 12", or "Feb 12, 2027" once the year stops being obvious. */
export function formatDate(ms: number, now = Date.now()): string {
  const format =
    new Date(ms).getFullYear() === new Date(now).getFullYear()
      ? dateFormat
      : dateWithYearFormat;
  return format.format(ms);
}

/** "2:00 PM". */
export function formatTime(ms: number): string {
  return timeFormat.format(ms);
}

/** "Thu, Feb 12, 2:00 PM" — the whole answer, for a header. */
export function formatWhen(ms: number): string {
  return fullFormat.format(ms);
}

/** An ISO string for a `<time dateTime>` attribute. */
export function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * "in 3 days", "2 hours ago", "now". Coarse on purpose: nobody schedules a
 * journal club to the minute, and a countdown that ticks is a distraction on a
 * screen somebody is trying to read a paper on.
 */
export function relativeWhen(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) {
    return "now";
  }
  if (abs < 60 * 60_000) {
    return relativeFormat.format(Math.round(diff / 60_000), "minute");
  }
  if (abs < DAY) {
    return relativeFormat.format(Math.round(diff / (60 * 60_000)), "hour");
  }
  if (abs < 7 * DAY) {
    return relativeFormat.format(Math.round(diff / DAY), "day");
  }
  if (abs < 30 * DAY) {
    return relativeFormat.format(Math.round(diff / (7 * DAY)), "week");
  }
  return relativeFormat.format(Math.round(diff / (30 * DAY)), "month");
}

/** "1h 12m", "48m", "under a minute" — how long a meeting actually ran. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) {
    return "under a minute";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * An epoch instant as `<input type="datetime-local">` wants it:
 * `YYYY-MM-DDTHH:mm`, in the reader's own zone with no offset on the end.
 */
export function toLocalInputValue(ms: number): string {
  const at = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/**
 * The way back. `null` when the field is empty or half-typed, which is what a
 * `datetime-local` gives you mid-edit — the caller keeps its button disabled
 * rather than sending `NaN` to the server.
 */
export function fromLocalInputValue(value: string): number | null {
  if (value.length === 0) {
    return null;
  }
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

/** The default a schedule form opens on: the next whole hour, tomorrow. */
export function defaultScheduleAt(now = Date.now()): number {
  const at = new Date(now + DAY);
  at.setMinutes(0, 0, 0);
  at.setHours(at.getHours() + 1);
  return at.getTime();
}

export type SessionStatus =
  | "scheduled"
  | "live"
  | "ended"
  | "synthesized"
  | "cancelled";

/** How a status reads in a chip. `scheduled` says nothing — it is the default. */
export function statusLabel(status: SessionStatus): string | null {
  switch (status) {
    case "live":
      return "Live";
    case "ended":
      return "Ended";
    case "synthesized":
      return "Written up";
    case "cancelled":
      return "Cancelled";
    default:
      return null;
  }
}

/** Still to come: on the calendar, or happening right now. */
export function isUpcoming(status: SessionStatus): boolean {
  return status === "scheduled" || status === "live";
}
