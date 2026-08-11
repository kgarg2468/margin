import { describe, expect, it } from "vitest";
import crons from "./crons";

/**
 * The first cron in this codebase, and the reason it is tested at all: a
 * schedule is a decision nobody re-reads. An interval typo turns a polite
 * hourly poll into a per-minute one against somebody else's API, and it does
 * so silently, on a deployment, at 3am.
 */
describe("the schedule", () => {
  it("polls Zotero hourly and nothing more often", () => {
    const jobs = Object.values(
      (crons as unknown as { crons: Record<string, { schedule: unknown }> })
        .crons,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.schedule).toEqual({ type: "interval", minutes: 60 });
  });

  it("points at the sweep, which is the part that stays cheap", () => {
    // The handler must be the fan-out, not `syncLink` — a cron pointed
    // straight at a sync would run one member's library forever.
    const jobs = Object.values(
      (crons as unknown as { crons: Record<string, { name: string }> }).crons,
    );
    expect(jobs[0]?.name).toContain("sweep");
  });
});
