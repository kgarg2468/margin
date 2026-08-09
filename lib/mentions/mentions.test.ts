import { describe, expect, it } from "vitest";
import {
  collectMentionedIds,
  disambiguate,
  findMentionQuery,
  insertMention,
  mentionSegments,
  rankCandidates,
} from "./mentions";

/**
 * The mention rules, pinned.
 *
 * Two of these tests are load-bearing for a promise rather than a feature.
 * `findMentionQuery` must not fire inside an email address, because a member
 * picker opening in the middle of `ada@university.edu` is how a methods note
 * becomes a message to somebody's supervisor. And `collectMentionedIds` must
 * drop a pick whose name has been deleted again, because the alternative is
 * notifying a person about a sentence that no longer names them.
 */

const LAB = [
  { id: "u_pi", name: "Sara Chen" },
  { id: "u_1", name: "Ada Okafor" },
  { id: "u_2", name: "Jo" },
  { id: "u_3", name: "Joanna Meyer" },
  { id: "u_4", name: "Zoë Marchetti" },
];

describe("findMentionQuery", () => {
  it("opens on an @ at the start of a note", () => {
    expect(findMentionQuery("@Sa", 3)).toEqual({
      start: 0,
      end: 3,
      query: "Sa",
    });
  });

  it("opens on an @ after a space", () => {
    const text = "This is for @Ada";
    expect(findMentionQuery(text, text.length)).toEqual({
      start: 12,
      end: 16,
      query: "Ada",
    });
  });

  it("opens on a bare @ with nothing typed yet", () => {
    expect(findMentionQuery("ask @", 5)).toEqual({
      start: 4,
      end: 5,
      query: "",
    });
  });

  it("does not open inside an email address", () => {
    const text = "write to ada@university.edu";
    expect(findMentionQuery(text, text.length)).toBeNull();
  });

  it("does not open inside a word", () => {
    const text = "n@me";
    expect(findMentionQuery(text, text.length)).toBeNull();
  });

  it("carries one space, so a surname can be typed", () => {
    const text = "@Sara Ch";
    expect(findMentionQuery(text, text.length)).toEqual({
      start: 0,
      end: 8,
      query: "Sara Ch",
    });
  });

  it("closes once the sentence moves on", () => {
    const text = "@Sara Chen thinks the assay is";
    expect(findMentionQuery(text, text.length)).toBeNull();
  });

  it("does not reach across a line break", () => {
    const text = "@Sara\nthe assay";
    expect(findMentionQuery(text, text.length)).toBeNull();
  });

  it("gives up rather than scanning an unbounded body", () => {
    const text = `@${"a".repeat(200)}`;
    expect(findMentionQuery(text, text.length)).toBeNull();
  });

  it("reads the mention the caret is in, not the last one in the body", () => {
    const text = "@Ada Okafor and @Jo";
    expect(findMentionQuery(text, 19)?.query).toBe("Jo");
    // Caret parked at the end of the first name: that mention is the one being
    // edited, so the picker re-opens on it rather than on the later one.
    expect(findMentionQuery(text, 11)?.query).toBe("Ada Okafor");
    // Past its trailing space, the sentence has moved on and neither is open.
    expect(findMentionQuery(text, 15)).toBeNull();
  });
});

describe("rankCandidates", () => {
  it("lists everyone for a bare @", () => {
    expect(rankCandidates(LAB, "").map((c) => c.id)).toEqual([
      "u_pi",
      "u_1",
      "u_2",
      "u_3",
      "u_4",
    ]);
  });

  it("puts a word-leading match ahead of a buried substring", () => {
    // "Ada Okafor" leads a word with it; the other three only contain it, and
    // among those the roster's own order is kept.
    expect(rankCandidates(LAB, "o").map((c) => c.id)).toEqual([
      "u_1",
      "u_2",
      "u_3",
      "u_4",
    ]);
  });

  it("puts a full-name match ahead of a match on a later word", () => {
    expect(rankCandidates(LAB, "me").map((c) => c.id)).toEqual(["u_3"]);
    expect(rankCandidates(LAB, "j").map((c) => c.id)).toEqual(["u_2", "u_3"]);
  });

  it("matches a surname typed on its own", () => {
    expect(rankCandidates(LAB, "chen").map((c) => c.id)).toEqual(["u_pi"]);
  });

  it("ignores case and accents", () => {
    expect(rankCandidates(LAB, "zoe").map((c) => c.id)).toEqual(["u_4"]);
  });

  it("matches across the space in a full name", () => {
    expect(rankCandidates(LAB, "Sara Ch").map((c) => c.id)).toEqual(["u_pi"]);
  });

  it("returns nothing when nobody matches", () => {
    expect(rankCandidates(LAB, "qqq")).toEqual([]);
  });

  it("honours the limit", () => {
    expect(rankCandidates(LAB, "", 2)).toHaveLength(2);
  });
});

describe("insertMention", () => {
  it("replaces the half-typed name and leaves the caret after it", () => {
    const text = "@Sa";
    const range = findMentionQuery(text, 3);
    expect(range).not.toBeNull();
    expect(insertMention(text, range!, "Sara Chen")).toEqual({
      text: "@Sara Chen ",
      caret: 11,
    });
  });

  it("inserts mid-sentence without disturbing the tail", () => {
    const text = "ask @Ad about the assay";
    const range = findMentionQuery(text, 7);
    // The caret lands after the name and before the space that was already
    // there — no second space gets stacked on it.
    expect(insertMention(text, range!, "Ada Okafor")).toEqual({
      text: "ask @Ada Okafor about the assay",
      caret: 15,
    });
  });

  it("does not stack a second space", () => {
    const text = "ask @Ad ";
    const range = findMentionQuery(text, 7);
    const result = insertMention(text, range!, "Ada Okafor");
    expect(result.text).toBe("ask @Ada Okafor ");
  });
});

describe("collectMentionedIds", () => {
  it("keeps a pick whose name is in the body", () => {
    expect(collectMentionedIds("@Sara Chen — is this the 2019 assay?", LAB)).toEqual([
      "u_pi",
    ]);
  });

  it("drops a pick the author typed and then deleted", () => {
    // Sara was picked, then the name was removed before saving.
    expect(collectMentionedIds("is this the 2019 assay?", LAB)).toEqual([]);
  });

  it("orders by where each name first appears", () => {
    const body = "@Jo and @Ada Okafor should compare notes";
    expect(collectMentionedIds(body, LAB)).toEqual(["u_2", "u_1"]);
  });

  it("does not let a short name match inside a longer one", () => {
    expect(collectMentionedIds("@Joanna Meyer ran it", LAB)).toEqual(["u_3"]);
  });

  it("ignores a name that is part of a word rather than a mention", () => {
    expect(collectMentionedIds("mail ada@Jo.example", LAB)).toEqual([]);
  });

  it("deduplicates a name written twice", () => {
    expect(collectMentionedIds("@Jo — and again, @Jo", LAB)).toEqual(["u_2"]);
  });

  it("caps how many people one note can name", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      id: `u_${i}`,
      name: `Person${i}`,
    }));
    const body = many.map((p) => `@${p.name}`).join(" ");
    expect(collectMentionedIds(body, many)).toHaveLength(10);
  });
});

describe("mentionSegments", () => {
  it("marks the runs that are names", () => {
    expect(mentionSegments("hi @Jo, thoughts?", ["Jo"])).toEqual([
      { text: "hi ", mention: false },
      { text: "@Jo", mention: true },
      { text: ", thoughts?", mention: false },
    ]);
  });

  it("prefers the longer of two overlapping names", () => {
    expect(mentionSegments("@Joanna Meyer ran it", ["Jo", "Joanna Meyer"])).toEqual(
      [
        { text: "@Joanna Meyer", mention: true },
        { text: " ran it", mention: false },
      ],
    );
  });

  it("returns one plain run when nothing is named", () => {
    expect(mentionSegments("just a note", ["Jo"])).toEqual([
      { text: "just a note", mention: false },
    ]);
  });

  it("returns nothing for an empty body", () => {
    expect(mentionSegments("", ["Jo"])).toEqual([]);
  });
});

describe("disambiguate", () => {
  it("leaves unique names alone", () => {
    expect(
      disambiguate([
        { name: "Sara Chen", email: "sara@lab.edu" },
        { name: "Ada Okafor", email: "ada@lab.edu" },
      ]).map((p) => p.name),
    ).toEqual(["Sara Chen", "Ada Okafor"]);
  });

  it("separates two people with the same name", () => {
    expect(
      disambiguate([
        { name: "Sara Chen", email: "s.chen@lab.edu" },
        { name: "Sara Chen", email: "sara.c@lab.edu" },
      ]).map((p) => p.name),
    ).toEqual(["Sara Chen (s.chen)", "Sara Chen (sara.c)"]);
  });

  it("leaves a collision it cannot resolve as it found it", () => {
    expect(
      disambiguate([{ name: "Sara Chen" }, { name: "Sara Chen" }]).map(
        (p) => p.name,
      ),
    ).toEqual(["Sara Chen", "Sara Chen"]);
  });
});
