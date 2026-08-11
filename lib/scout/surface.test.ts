import { describe, expect, it } from "vitest";
import {
  citationSummary,
  coverageLine,
  drawnStatusLine,
  droppedLine,
  scoutStatusLine,
} from "./surface";

/**
 * What a reader is told about a machine's work, and — more to the point — what
 * they are never told. Every sentence here is written by us out of counts and
 * closed vocabularies; none of it is the model's, and none of it says anything
 * about a note that has stopped being shared beyond the fact that a line was
 * here.
 */
describe("scoutStatusLine", () => {
  it("says nothing at all when nobody asked", () => {
    expect(scoutStatusLine(undefined)).toBeNull();
  });

  it("says the scout is looking, while it is", () => {
    expect(scoutStatusLine({ status: "queued" })).toBe("Scout is looking back…");
    expect(scoutStatusLine({ status: "running" })).toBe("Scout is looking back…");
  });

  it("says nothing once it returned — the finding is the answer", () => {
    expect(scoutStatusLine({ status: "returned" })).toBeNull();
  });

  it("calls an empty run a result, not a failure", () => {
    expect(scoutStatusLine({ status: "empty" })).toBe(
      "The scout read the lab's margin and found nothing that bears on this.",
    );
  });

  it("prints the sentence the backend wrote for the failure it had", () => {
    expect(
      scoutStatusLine({
        status: "failed",
        failureReason: "The scout couldn't reach its model.",
      }),
    ).toBe("The scout couldn't reach its model.");
  });

  it("falls back to a sentence of ours when a row carries none", () => {
    expect(scoutStatusLine({ status: "failed" })).toBe(
      "The scout's run didn't finish. Nothing was stored.",
    );
  });

  it("says nothing about a run that was called off", () => {
    // Cancellation is the cascade: the question was settled or withdrawn. The
    // page already shows that, and a second notice about a machine stopping
    // would be the product talking about itself.
    expect(scoutStatusLine({ status: "cancelled" })).toBeNull();
  });
});

/**
 * The same vocabulary, composed against what is already on the page. A rerun
 * is the whole subject here: a question that has been scouted twice has a
 * standing report *and* a new run walking its lifecycle, and which of those
 * two a reader is told about is a judgement, not an accident.
 */
describe("drawnStatusLine", () => {
  it("draws nothing for a question nobody scouted", () => {
    expect(drawnStatusLine(undefined, false)).toBeNull();
    expect(drawnStatusLine(undefined, true)).toBeNull();
  });

  it("says a new run is under way, over the top of the last one's report", () => {
    expect(drawnStatusLine({ status: "queued" }, true)).toBe(
      "Scout is looking back…",
    );
    expect(drawnStatusLine({ status: "running" }, true)).toBe(
      "Scout is looking back…",
    );
  });

  it("says the same thing when there is no report underneath it yet", () => {
    expect(drawnStatusLine({ status: "running" }, false)).toBe(
      "Scout is looking back…",
    );
  });

  it("holds its tongue when a rerun came back empty and a report is standing", () => {
    expect(drawnStatusLine({ status: "empty" }, true)).toBeNull();
  });

  it("holds its tongue when a rerun failed and a report is standing", () => {
    expect(
      drawnStatusLine(
        { status: "failed", failureReason: "The scout couldn't reach its model." },
        true,
      ),
    ).toBeNull();
  });

  it("says an empty run out loud when there is no report to stand on", () => {
    expect(drawnStatusLine({ status: "empty" }, false)).toBe(
      "The scout read the lab's margin and found nothing that bears on this.",
    );
  });

  it("says a failure out loud when there is no report to stand on", () => {
    expect(drawnStatusLine({ status: "failed" }, false)).toBe(
      "The scout's run didn't finish. Nothing was stored.",
    );
  });

  it("says nothing once a run returned, report or no report", () => {
    expect(drawnStatusLine({ status: "returned" }, true)).toBeNull();
    expect(drawnStatusLine({ status: "returned" }, false)).toBeNull();
  });

  it("says nothing about a run that was called off, either way", () => {
    expect(drawnStatusLine({ status: "cancelled" }, true)).toBeNull();
    expect(drawnStatusLine({ status: "cancelled" }, false)).toBeNull();
  });
});

describe("coverageLine", () => {
  it("counts what the scout was shown, in the plural it needs", () => {
    expect(
      coverageLine({ annotationsSearched: 24, papersTouched: 3, queriesRun: 1 }),
    ).toBe("Read 24 notes across 3 papers.");
  });

  it("says it in the singular when that is what happened", () => {
    expect(
      coverageLine({ annotationsSearched: 1, papersTouched: 1, queriesRun: 1 }),
    ).toBe("Read 1 note on 1 paper.");
  });
});

describe("droppedLine", () => {
  it("says nothing when nothing was lost", () => {
    expect(droppedLine({ droppedForCitation: 0, redactedCount: 0 })).toBeNull();
  });

  it("counts what the citation gate refused", () => {
    expect(droppedLine({ droppedForCitation: 2, redactedCount: 0 })).toBe(
      "2 lines were dropped because the scout couldn't cite them.",
    );
  });

  it("counts what the margin took back, separately", () => {
    expect(droppedLine({ droppedForCitation: 0, redactedCount: 1 })).toBe(
      "1 line rested on notes that are no longer shared.",
    );
  });

  it("says both when both happened", () => {
    expect(droppedLine({ droppedForCitation: 1, redactedCount: 2 })).toBe(
      "1 line was dropped because the scout couldn't cite it. 2 lines rested on notes that are no longer shared.",
    );
  });
});

describe("citationSummary", () => {
  const known = new Map([
    ["a1", { authorName: "Ana Ruiz", pageIndex: 3 }],
    ["a2", { authorName: "Ben Okafor", pageIndex: 7 }],
  ]);

  it("names the notes this page can resolve", () => {
    expect(citationSummary(["a1", "a2"], known)).toEqual({
      resolved: [
        { id: "a1", authorName: "Ana Ruiz", pageIndex: 3 },
        { id: "a2", authorName: "Ben Okafor", pageIndex: 7 },
      ],
      elsewhere: 0,
    });
  });

  it("counts the ones it cannot, rather than inventing a name for them", () => {
    expect(citationSummary(["a1", "far"], known)).toEqual({
      resolved: [{ id: "a1", authorName: "Ana Ruiz", pageIndex: 3 }],
      elsewhere: 1,
    });
  });
});
