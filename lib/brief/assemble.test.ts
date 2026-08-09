import { describe, expect, it } from "vitest";
import { detectCollisions } from "../digest/engine";
import {
  assembleBrief,
  noteLine,
  MAX_SECTION_ITEMS,
  type BriefAnnotation,
  type BriefSectionKey,
} from "./assemble";

let counter = 0;

const NAMES: Record<string, string> = {
  ana: "Ana Ruiz",
  ben: "Ben Okafor",
  cara: "Cara Lindqvist",
};

/** A minimal annotation; every field has a boring default so a test says only what it means. */
function ann(
  overrides: Partial<BriefAnnotation> & { memberId: string },
): BriefAnnotation {
  counter += 1;
  return {
    id: `a${counter}`,
    paperId: "p1",
    memberName: NAMES[overrides.memberId] ?? "Someone",
    type: "note",
    pageIndex: 0,
    start: 100,
    end: 200,
    quote: "the model attends to every position in the sequence",
    body: "",
    createdAt: 1000 + counter,
    ...overrides,
  };
}

const PAPER = "Attention Is All You Need";

/** Prior sessions are given as `id` → when they were held. */
function brief(
  pool: readonly BriefAnnotation[],
  prior: readonly string[] = [],
  cap?: number,
) {
  return assembleBrief({
    pool,
    paperTitle: PAPER,
    priorSessions: new Map(prior.map((id, index) => [id, 500 + index])),
    ...(cap === undefined ? {} : { cap }),
  });
}

function sectionOf(
  result: ReturnType<typeof brief>,
  key: BriefSectionKey,
) {
  const found = result.sections.find((one) => one.key === key);
  if (found === undefined) throw new Error(`no ${key} section`);
  return found;
}

describe("noteLine", () => {
  it("prefers what the member wrote over the passage they wrote it on", () => {
    const line = noteLine(
      ann({ memberId: "ana", body: "Does this control for batch effects?" }),
    );
    expect(line).toBe(
      "Ana Ruiz, p. 1: “Does this control for batch effects?”",
    );
  });

  it("falls back to the passage, and says that is what it is showing", () => {
    const line = noteLine(ann({ memberId: "ben", pageIndex: 6, quote: "we train for 100k steps" }));
    expect(line).toBe(
      "Ben Okafor, p. 7, marked without a comment, on: “we train for 100k steps”",
    );
  });

  it("survives an annotation with neither a body nor a quote", () => {
    const line = noteLine(ann({ memberId: "ana", quote: "", body: "  " }));
    expect(line).toBe("Ana Ruiz, p. 1, marked without a comment");
  });

  it("names the kind of note when given a lead", () => {
    const line = noteLine(
      ann({ memberId: "cara", pageIndex: 2, body: "The ablation is underpowered." }),
      "critique",
    );
    expect(line).toBe(
      "Cara Lindqvist’s critique on p. 3: “The ablation is underpowered.”",
    );
  });

  it("elides a long body rather than carrying a paragraph", () => {
    const line = noteLine(ann({ memberId: "ana", body: "x".repeat(400) }));
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(220);
  });

  it("collapses the whitespace a textarea leaves behind", () => {
    const line = noteLine(ann({ memberId: "ana", body: "two\n\nlines   here" }));
    expect(line).toBe("Ana Ruiz, p. 1: “two lines here”");
  });
});

describe("collisions", () => {
  it("promotes a gold typed pair, with its matrix cell", () => {
    const pool = [
      ann({ memberId: "ana", type: "hypothesis", body: "Maybe depth is doing the work." }),
      ann({ memberId: "ben", type: "critique", body: "Depth is confounded with width here." }),
    ];
    const section = sectionOf(brief(pool), "collisions");
    expect(section.items).toHaveLength(1);
    expect(section.items[0]?.pairType).toBe("critique x hypothesis");
    expect(section.items[0]?.annotationIds).toHaveLength(2);
  });

  it("names both members rather than addressing a reader as 'you'", () => {
    // A brief is read by the presenter and the PI and outlives both, so no
    // line in it may be written from one person's side.
    const pool = [
      ann({ memberId: "ana", type: "hypothesis" }),
      ann({ memberId: "ben", type: "critique" }),
    ];
    const text = sectionOf(brief(pool), "collisions").items[0]?.text ?? "";
    expect(text).toContain("Ana Ruiz");
    expect(text).toContain("Ben Okafor");
    expect(text).toContain(PAPER);
    // The claim is about the phrase, not the citation after it — this paper is
    // called "Attention Is All You Need".
    const phrase = text.split(" — ")[0] ?? "";
    expect(phrase.toLowerCase()).not.toMatch(/\byou\b/);
  });

  it("ignores a pair the gold matrix does not name", () => {
    const pool = [
      ann({ memberId: "ana", type: "note" }),
      ann({ memberId: "ben", type: "definition" }),
    ];
    expect(sectionOf(brief(pool), "collisions").items).toEqual([]);
  });

  it("ignores two annotations by the same member", () => {
    const pool = [
      ann({ memberId: "ana", type: "hypothesis" }),
      ann({ memberId: "ana", type: "critique" }),
    ];
    expect(sectionOf(brief(pool), "collisions").items).toEqual([]);
  });

  it("does not reach across the paper boundary", () => {
    // Phase 2 lifts this; today a brief is about one paper and says so.
    const pool = [
      ann({ memberId: "ana", type: "hypothesis", paperId: "p1" }),
      ann({ memberId: "ben", type: "critique", paperId: "p2", quote: "different text entirely" }),
    ];
    expect(sectionOf(brief(pool), "collisions").items).toEqual([]);
  });

  it("accepts a precomputed detection pass and agrees with its own", () => {
    const pool = [
      ann({ memberId: "ana", type: "hypothesis" }),
      ann({ memberId: "ben", type: "method-note" }),
    ];
    const precomputed = assembleBrief({
      pool,
      paperTitle: PAPER,
      priorSessions: new Map<string, number>(),
      collisions: detectCollisions(pool),
    });
    expect(sectionOf(precomputed, "collisions").items).toEqual(
      sectionOf(brief(pool), "collisions").items,
    );
  });
});

describe("open questions", () => {
  it("carries an open question that nobody replied to", () => {
    const pool = [
      ann({ memberId: "ana", type: "open-question", body: "What is the batch size?" }),
    ];
    const section = sectionOf(brief(pool), "open-questions");
    expect(section.items).toHaveLength(1);
    expect(section.items[0]?.text).toContain("What is the batch size?");
  });

  it("drops one that already has a thread under it", () => {
    // A question with replies is being handled. Floor time is for the ones
    // sitting alone.
    const question = ann({ memberId: "ana", type: "open-question", body: "Why 8 heads?" });
    const pool = [
      question,
      ann({ memberId: "ben", type: "note", parentId: question.id, body: "Ablation in §4." }),
    ];
    expect(sectionOf(brief(pool), "open-questions").items).toEqual([]);
  });

  it("never makes a reply into an item of its own", () => {
    const parent = ann({ memberId: "ana", type: "critique", body: "Underpowered." });
    const pool = [
      parent,
      ann({
        memberId: "ben",
        type: "open-question",
        parentId: parent.id,
        body: "How many replicates would we need?",
      }),
    ];
    expect(sectionOf(brief(pool), "open-questions").items).toEqual([]);
  });

  it("puts the newest first", () => {
    const older = ann({
      memberId: "ana",
      type: "open-question",
      body: "older",
      createdAt: 10,
    });
    const newer = ann({
      memberId: "ben",
      type: "open-question",
      body: "newer",
      createdAt: 99,
    });
    const items = sectionOf(brief([older, newer]), "open-questions").items;
    expect(items[0]?.annotationIds).toEqual([newer.id]);
  });
});

describe("carried over from earlier sessions", () => {
  it("moves an unanswered question from a prior session into its own section", () => {
    const stale = ann({
      memberId: "ana",
      type: "open-question",
      body: "Did anyone check the negative control?",
      sessionId: "s-march",
      createdAt: 10,
    });
    const result = brief([stale], ["s-march"]);
    const carried = sectionOf(result, "carried-over");
    expect(carried.items).toHaveLength(1);
    expect(carried.items[0]?.fromSessionId).toBe("s-march");
    // Carries when that meeting was, so the panel can say "still open from
    // Feb 12" rather than "raised in an earlier session".
    expect(carried.items[0]?.fromSessionAt).toBe(500);
    // And it is not double-counted as fresh prep.
    expect(sectionOf(result, "open-questions").items).toEqual([]);
  });

  it("leaves a question from this session, or from no session, as ordinary prep", () => {
    const thisSession = ann({
      memberId: "ana",
      type: "open-question",
      body: "current",
      sessionId: "s-now",
    });
    const noSession = ann({ memberId: "ben", type: "open-question", body: "loose" });
    const result = brief([thisSession, noSession], ["s-march"]);
    expect(sectionOf(result, "carried-over").items).toEqual([]);
    expect(sectionOf(result, "open-questions").items).toHaveLength(2);
  });

  it("puts the oldest first — a question that outlasted three meetings leads", () => {
    const ancient = ann({
      memberId: "ana",
      type: "open-question",
      body: "ancient",
      sessionId: "s1",
      createdAt: 10,
    });
    const recent = ann({
      memberId: "ben",
      type: "open-question",
      body: "recent",
      sessionId: "s2",
      createdAt: 900,
    });
    const items = sectionOf(brief([recent, ancient], ["s1", "s2"]), "carried-over")
      .items;
    expect(items[0]?.annotationIds).toEqual([ancient.id]);
  });

  it("does not carry a question a prior session answered", () => {
    const question = ann({
      memberId: "ana",
      type: "open-question",
      body: "settled",
      sessionId: "s1",
    });
    const pool = [
      question,
      ann({ memberId: "ben", type: "note", parentId: question.id, body: "It's in §3." }),
    ];
    expect(sectionOf(brief(pool, ["s1"]), "carried-over").items).toEqual([]);
  });
});

describe("the floor", () => {
  function withReplies(
    parent: BriefAnnotation,
    count: number,
  ): BriefAnnotation[] {
    return [
      parent,
      ...Array.from({ length: count }, () =>
        ann({ memberId: "cara", type: "note", parentId: parent.id, body: "…" }),
      ),
    ];
  }

  it("ranks critiques and method notes by how many replies they drew", () => {
    const quiet = ann({ memberId: "ana", type: "critique", body: "quiet" });
    const loud = ann({ memberId: "ben", type: "method-note", body: "loud" });
    const pool = [...withReplies(quiet, 1), ...withReplies(loud, 4)];
    const items = sectionOf(brief(pool), "floor").items;
    expect(items.map((item) => item.annotationIds[0])).toEqual([loud.id, quiet.id]);
    expect(items[0]?.text).toContain("4 replies");
    expect(items[1]?.text).toContain("1 reply");
  });

  it("names the kind of note in the line", () => {
    const critique = ann({ memberId: "ana", type: "critique", body: "The ablation is thin." });
    const items = sectionOf(brief(withReplies(critique, 2)), "floor").items;
    expect(items[0]?.text).toBe(
      "Ana Ruiz’s critique on p. 1: “The ablation is thin.” — 2 replies",
    );
  });

  it("leaves out a critique nobody answered", () => {
    // Not floor time: nothing has happened around it yet. It is still in the
    // margin for anyone who opens the paper.
    const lonely = ann({ memberId: "ana", type: "critique", body: "unanswered" });
    expect(sectionOf(brief([lonely]), "floor").items).toEqual([]);
  });

  it("leaves out types that are not critiques or method notes", () => {
    const hypothesis = ann({ memberId: "ana", type: "hypothesis", body: "h" });
    expect(sectionOf(brief(withReplies(hypothesis, 3)), "floor").items).toEqual([]);
  });
});

describe("caps and citations", () => {
  it("caps a section and reports what it held back", () => {
    const pool = Array.from({ length: MAX_SECTION_ITEMS + 3 }, (_, i) =>
      ann({ memberId: "ana", type: "open-question", body: `q${i}` }),
    );
    const section = sectionOf(brief(pool), "open-questions");
    expect(section.items).toHaveLength(MAX_SECTION_ITEMS);
    expect(section.droppedCount).toBe(3);
  });

  it("reports nothing dropped when everything fits", () => {
    const pool = [ann({ memberId: "ana", type: "open-question", body: "one" })];
    expect(sectionOf(brief(pool), "open-questions").droppedCount).toBe(0);
  });

  it("honours an explicit cap", () => {
    const pool = Array.from({ length: 5 }, (_, i) =>
      ann({ memberId: "ana", type: "open-question", body: `q${i}` }),
    );
    expect(sectionOf(brief(pool, [], 2), "open-questions").items).toHaveLength(2);
  });

  it("cites every line it prints, and nothing it dropped", () => {
    const a = ann({ memberId: "ana", type: "hypothesis" });
    const b = ann({ memberId: "ben", type: "critique" });
    const q = ann({ memberId: "cara", type: "open-question", body: "why?" });
    const result = brief([a, b, q]);
    for (const section of result.sections) {
      for (const item of section.items) {
        expect(item.annotationIds.length).toBeGreaterThan(0);
      }
    }
    // a and b are the collision; q is the open question. Three distinct rows.
    expect(result.citationCount).toBe(3);
  });

  it("counts an annotation once even when two sections cite it", () => {
    // A "possible answer" collision is definition × open-question, so the
    // question appears in both lenses on purpose.
    const question = ann({ memberId: "ana", type: "open-question", body: "what is a head?" });
    const definition = ann({ memberId: "ben", type: "definition", body: "a head is…" });
    const result = brief([question, definition]);
    expect(sectionOf(result, "collisions").items).toHaveLength(1);
    expect(sectionOf(result, "open-questions").items).toHaveLength(1);
    expect(result.citationCount).toBe(2);
  });

  it("returns all four sections even when the margin is empty", () => {
    // An absent section would move the page around as a lab annotates; an
    // empty one is a fact about the meeting.
    const result = brief([]);
    expect(result.sections.map((one) => one.key)).toEqual([
      "collisions",
      "open-questions",
      "carried-over",
      "floor",
    ]);
    expect(result.sections.every((one) => one.items.length === 0)).toBe(true);
    expect(result.citationCount).toBe(0);
  });

  it("is deterministic — the same margin twice is the same brief", () => {
    const pool = [
      ann({ memberId: "ana", type: "hypothesis" }),
      ann({ memberId: "ben", type: "critique" }),
      ann({ memberId: "cara", type: "open-question", body: "why?" }),
    ];
    expect(brief(pool)).toEqual(brief([...pool].reverse()));
  });
});
