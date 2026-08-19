import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * Everything this deployment does on its own.
 *
 * The first scheduled work in Margin, and the bar it sets for the next one:
 * a cron here must be cheap when there is nothing to do. `zotero.sweep` reads
 * one index for links older than an hour and schedules a run for each; a run
 * against an unchanged library is a single conditional request that comes back
 * `304`. A deployment where nobody has touched their Zotero all day costs one
 * small request per linked library per hour, and writes nothing.
 *
 * Hourly rather than more often because Zotero is a personal library, not a
 * feed — a paper added at 2pm appearing on the shelf by 3pm is the expectation
 * this is built to, and a member who wants it now has Sync now. Hourly rather
 * than less often because a daily poll makes the button the only real path,
 * and then the sync is a manual feature wearing a schedule.
 */
const crons = cronJobs();

crons.interval("zotero sweep", { minutes: 60 }, internal.zotero.sweep, {});

/**
 * Rate counters for links nobody came back to.
 *
 * A live link's counter is overwritten in place by its next fetch, so this is
 * only ever about abandoned ones — and without it, a link opened once and
 * forgotten would leave one number and one minute in the table indefinitely.
 * The table's promise about what survives at rest is bounded by this cadence,
 * which is the only reason the promise is worth writing down.
 *
 * Meets the bar the comment above sets: one index scan for windows that have
 * ended, finding nothing on a deployment where no link has been fetched.
 */
crons.interval(
  "share rate window sweep",
  { minutes: 30 },
  internal.shares.sweepRateWindows,
  {},
);

export default crons;
