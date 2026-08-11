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

export default crons;
