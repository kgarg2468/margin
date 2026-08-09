import { describe, expect, it } from "vitest";
import {
  chunkMrkdwn,
  composeBoundaryMessage,
  composeBriefMessage,
  composeSynthesisMessage,
  escapeSlack,
  escapeWithin,
  markdownToMrkdwn,
  slackDate,
  type SlackBlock,
  type SlackMessage,
} from "./compose";

/**
 * What a lab's channel actually receives.
 *
 * The composers are pure, which makes the thing that is usually untestable
 * testable: the wording, the shape and the bounds of a message nobody on the
 * team ever looks at again once it is written. `convex/slack.guard.test.ts`
 * covers the promises — no remote assets, no tracking, nothing that sells
 * anything — and this covers whether the post is any good.
 */

const SITE = "https://margin.example.edu";
const SESSION_URL = `${SITE}/app/sessions/s1`;
const PAPER_URL = `${SITE}/app/library/p1/read`;
const AT = Date.UTC(2026, 7, 13, 16, 0, 0);

/** A title at the 500-character cap `convex/papers.ts` enforces. */
const LONG_TITLE =
  `On the Reproducibility of Attention Mechanisms Under Ablation: ${"a subtitle of the sort a preprint genuinely carries, ".repeat(10)}`.slice(
    0,
    500,
  );

const brief = (
  overrides: Partial<Parameters<typeof composeBriefMessage>[0]> = {},
): SlackMessage =>
  composeBriefMessage({
    paperTitle: "Attention Is All You Need",
    when: slackDate(AT),
    presenterName: "Ada Lovelace",
    approvedByName: "Ada Lovelace",
    citationCount: 12,
    sections: [
      {
        heading: "Where the lab disagrees",
        items: [
          "Ana Ruiz critiqued the passage Ben Okafor hypothesised about — p. 7: “we hold the head count fixed”",
        ],
        droppedCount: 0,
      },
      {
        heading: "Open questions",
        items: [
          "Ben Okafor, p. 4: “what fixes the temperature here?”",
          "Nadia Haddad, p. 9: “is this the same ablation as figure 3?”",
        ],
        droppedCount: 3,
      },
    ],
    url: SESSION_URL,
    ...overrides,
  });

const boundary = (
  overrides: Partial<Parameters<typeof composeBoundaryMessage>[0]> = {},
): SlackMessage =>
  composeBoundaryMessage({
    paperTitle: "Attention Is All You Need",
    when: slackDate(AT),
    presenterName: "Ada Lovelace",
    lines: [
      "Ana Ruiz and Ben Okafor both left a hypothesis on the same passage — Attention Is All You Need, p. 7: “scaled dot-product attention”",
    ],
    annotationCount: 41,
    url: PAPER_URL,
    ...overrides,
  });

const synthesis = (
  overrides: Partial<Parameters<typeof composeSynthesisMessage>[0]> = {},
): SlackMessage =>
  composeSynthesisMessage({
    paperTitle: "Attention Is All You Need",
    when: slackDate(AT),
    approvedByName: "Ada Lovelace",
    markdown: [
      "## What we settled",
      "",
      "- The ablation replicates at our scale — Ana Ruiz, Ben Okafor",
      "- The temperature term is doing more work than the paper claims — Nadia Haddad",
      "",
      "## Still open",
      "",
      "- Whether the head count matters below 8 — Ben Okafor",
    ].join("\n"),
    citationCount: 18,
    revised: false,
    url: SESSION_URL,
    ...overrides,
  });

const messages = (): { name: string; message: SlackMessage; url: string }[] => [
  { name: "brief", message: brief(), url: SESSION_URL },
  { name: "boundary post", message: boundary(), url: PAPER_URL },
  { name: "write-up", message: synthesis(), url: SESSION_URL },
  {
    name: "revised write-up",
    message: synthesis({ revised: true }),
    url: SESSION_URL,
  },
];

/** Every string that will be rendered, from whatever block carries it. */
function textOf(block: SlackBlock): string {
  if (block.type === "divider") return "";
  if (block.type === "context") {
    return block.elements.map((element) => element.text).join("\n");
  }
  return block.text.text;
}

const allText = (message: SlackMessage): string =>
  [message.text, ...message.blocks.map(textOf)].join("\n");

// --- Escaping ---------------------------------------------------------------

describe("escapeSlack", () => {
  it("neutralizes the three characters Slack reads as markup", () => {
    expect(escapeSlack("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("leaves formatting a member is entitled to type", () => {
    // The worst `*` and `_` can do is embolden somebody's own sentence.
    expect(escapeSlack("*bold* _italic_ `code`")).toBe(
      "*bold* _italic_ `code`",
    );
  });

  it("defuses a link a member typed into a note", () => {
    // This is the whole reason the function exists: `<url|label>` is Slack's
    // link syntax and it is three characters anybody can type.
    const escaped = escapeSlack("<https://evil.example|click here>");
    expect(escaped).not.toContain("<https");
    expect(escaped).toBe("&lt;https://evil.example|click here&gt;");
  });
});

describe("escapeWithin", () => {
  it("measures the bound on the escaped string, not the source", () => {
    // 40 ampersands is 200 characters by the time Slack counts them.
    const out = escapeWithin("&".repeat(40), 50);
    expect(out.length).toBeLessThanOrEqual(50);
  });

  it("never cuts inside an entity", () => {
    const out = escapeWithin("&".repeat(40), 50);
    expect(out).not.toMatch(/&(?!amp;|lt;|gt;)/);
  });

  it("says when it dropped something, and not when it didn't", () => {
    expect(escapeWithin("short", 50)).toBe("short");
    expect(escapeWithin("x".repeat(100), 20)).toMatch(/…$/);
    expect(escapeWithin("x".repeat(100), 20).length).toBeLessThanOrEqual(20);
  });
});

// --- Reader-local dates -----------------------------------------------------

describe("slackDate", () => {
  it("asks Slack to render the moment in each reader's timezone", () => {
    expect(slackDate(AT)).toMatch(/^<!date\^\d+\^/);
    expect(slackDate(AT)).toContain("{date_long_pretty} at {time}");
  });

  it("carries a real date as the fallback, not a placeholder", () => {
    const fallback = slackDate(AT).split("|")[1]?.slice(0, -1) ?? "";
    expect(fallback).toContain("2026");
    expect(Number.isNaN(Date.parse(fallback))).toBe(false);
  });

  it("cannot close the command it sits inside", () => {
    // One `>` in the whole string, and it is the terminator.
    expect([...slackDate(AT).matchAll(/>/g)]).toHaveLength(1);
    expect([...slackDate(AT).matchAll(/\|/g)]).toHaveLength(1);
  });
});

// --- Shape ------------------------------------------------------------------

describe("every message", () => {
  it.each(messages())("$name leads with a headline", ({ message }) => {
    const first = message.blocks[0];
    expect(first?.type).toBe("header");
    // Slack caps a header at 150 and renders `:shortcode:` as an emoji unless
    // told not to; a paper title is not a reaction.
    if (first?.type === "header") {
      expect(first.text.text.length).toBeLessThanOrEqual(150);
      expect(first.text.emoji).toBe(false);
    }
  });

  it.each(messages())("$name says where it came from", ({ message }) => {
    expect(message.blocks[1]?.type).toBe("context");
    expect(textOf(message.blocks[1] as SlackBlock)).toContain("<!date^");
  });

  it.each(messages())("$name ends with one way back in", ({ message, url }) => {
    const last = message.blocks.at(-1);
    expect(last?.type).toBe("context");
    expect(textOf(last as SlackBlock)).toContain(`<${url}|`);
  });

  it.each(messages())("$name offers exactly one link", ({ message, url }) => {
    // Not two, and in particular nothing on a redirector's domain — the same
    // rule `convex/email.guard.test.ts` holds the templates to.
    const links = [...allText(message).matchAll(/<(https?:\/\/[^|>]+)\|/g)].map(
      (match) => match[1],
    );
    expect(links).toEqual([url]);
  });

  it.each(messages())("$name has a sidebar line that says what it is", ({
    message,
  }) => {
    expect(message.text.length).toBeGreaterThan(20);
    expect(message.text).not.toContain("undefined");
    expect(message.text).not.toMatch(/\bnull\b/);
    // The fallback is a sentence, not a block dump.
    expect(message.text).not.toContain("\n");
  });

  it.each(messages())("$name stays inside Slack's ceilings", ({ message }) => {
    expect(message.blocks.length).toBeLessThanOrEqual(50);
    for (const block of message.blocks) {
      if (block.type === "section") {
        expect(block.text.text.length).toBeLessThanOrEqual(3000);
      }
      if (block.type === "context") {
        expect(block.elements.length).toBeLessThanOrEqual(10);
        for (const element of block.elements) {
          expect(element.text.length).toBeLessThanOrEqual(2000);
        }
      }
    }
  });

  it.each(messages())("$name uses only the four block types", ({ message }) => {
    // No `image`, no `accessory`, no `actions` — see the constitution note in
    // `lib/slack/compose.ts`. The type union already forbids it; this is the
    // assertion that survives somebody widening the union.
    const kinds = new Set(message.blocks.map((block) => block.type));
    for (const kind of kinds) {
      expect(["header", "section", "context", "divider"]).toContain(kind);
    }
  });
});

// --- The brief --------------------------------------------------------------

describe("the brief", () => {
  it("names the paper, the presenter and who reviewed it", () => {
    const text = allText(brief());
    expect(text).toContain("Attention Is All You Need");
    expect(text).toContain("Ada Lovelace presenting");
    expect(text).toContain("reviewed by Ada Lovelace");
  });

  it("keeps a section's heading with its own lines", () => {
    // One section block per heading rather than one per bullet: Slack's
    // inter-block margin turns a four-line list into half a screen.
    const section = brief().blocks.find(
      (block) => block.type === "section" && block.text.text.includes("Open questions"),
    );
    expect(section).toBeDefined();
    expect(textOf(section as SlackBlock)).toContain(
      "*Open questions*\n•  Ben Okafor, p. 4",
    );
    expect(textOf(section as SlackBlock)).toContain("Nadia Haddad, p. 9");
  });

  it("says what the per-section cap held back, next to the section", () => {
    const text = allText(brief());
    expect(text).toContain("_and 3 more like them_");
  });

  it("counts one held-back candidate in the singular", () => {
    const one = brief({
      sections: [{ heading: "Open questions", items: ["a line"], droppedCount: 1 }],
    });
    expect(allText(one)).toContain("_and 1 more like it_");
  });

  it("says how much of the lab's writing it rests on", () => {
    expect(allText(brief())).toContain("Assembled from 12 notes the lab wrote");
    expect(allText(brief({ citationCount: 1 }))).toContain(
      "Assembled from 1 note the lab wrote",
    );
  });

  it("shortens a 500-character title rather than posting all of it", () => {
    const long = brief({ paperTitle: LONG_TITLE });
    const header = long.blocks[0];
    expect(header?.type).toBe("header");
    if (header?.type === "header") {
      expect(header.text.text.length).toBeLessThanOrEqual(150);
      expect(header.text.text).toContain("On the Reproducibility of Attention");
      expect(header.text.text).toMatch(/…$/);
    }
    expect(long.text).not.toContain(LONG_TITLE);
  });

  it("bounds a display name nothing else in the product bounds", () => {
    const long = brief({ presenterName: "Q".repeat(400) });
    expect(textOf(long.blocks[1] as SlackBlock).length).toBeLessThanOrEqual(
      2000,
    );
    expect(allText(long)).not.toContain("Q".repeat(400));
  });
});

// --- The boundary post ------------------------------------------------------

describe("the boundary post", () => {
  it("never says “you” to a room", () => {
    // The lines arrive pre-rendered with no recipient, which is what keeps a
    // channel from being addressed as though it were a person. A digest line
    // written for a member says "Ben critiqued the passage you hypothesised
    // about"; a channel is not one of the authors and has no "you" to be.
    //
    // The fixture's usual title contains the word, which is exactly the sort
    // of thing that makes a scan like this vacuous, so this one does not.
    const room = boundary({
      paperTitle: "Scaling Laws for Neural Language Models",
      lines: [
        "Ana Ruiz critiqued the passage Ben Okafor hypothesised about — Scaling Laws for Neural Language Models, p. 7: “the exponent is stable”",
      ],
    });
    expect(allText(room)).not.toMatch(/\byou\b/i);
    expect(allText(room)).toContain("Ana Ruiz critiqued the passage Ben Okafor");
  });

  it("leads with how much is in the margin", () => {
    expect(allText(boundary())).toContain("41 notes in the margin");
    expect(allText(boundary({ annotationCount: 1 }))).toContain(
      "1 note in the margin",
    );
  });

  it("says plainly when nothing has collided yet", () => {
    // The most actionable thing this post ever says, so it is a sentence
    // rather than an omission.
    const quiet = boundary({ lines: [] });
    expect(allText(quiet)).toContain("Nothing in the margin has collided yet");
    expect(quiet.blocks.some((block) => block.type === "section")).toBe(true);
  });
});

// --- The write-up -----------------------------------------------------------

describe("markdownToMrkdwn", () => {
  it("turns a heading into the only thing Slack has for one", () => {
    // Left alone, `##` renders as two hash marks.
    expect(markdownToMrkdwn("## What we settled")).toBe("*What we settled*");
    expect(markdownToMrkdwn("### Deeper")).toBe("*Deeper*");
  });

  it("turns a hyphen list into a bulleted one", () => {
    expect(markdownToMrkdwn("- a point")).toBe("•  a point");
    expect(markdownToMrkdwn("* a point")).toBe("•  a point");
  });

  it("leaves a paragraph as the approver typed it", () => {
    expect(markdownToMrkdwn("We agreed, mostly.")).toBe("We agreed, mostly.");
  });

  it("escapes before it marks up, so typed markup is inert", () => {
    const out = markdownToMrkdwn("- see <https://evil.example|here>");
    expect(out).toBe("•  see &lt;https://evil.example|here&gt;");
    expect(out).not.toContain("<https");
  });

  it("does not mistake a hyphenated word for a bullet", () => {
    expect(markdownToMrkdwn("well-known result")).toBe("well-known result");
  });
});

describe("chunkMrkdwn", () => {
  it("breaks between paragraphs rather than mid-sentence", () => {
    const chunks = chunkMrkdwn("aaaa\n\nbbbb\n\ncccc", 10);
    expect(chunks).toEqual(["aaaa\n\nbbbb", "cccc"]);
  });

  it("packs what fits into one chunk", () => {
    expect(chunkMrkdwn("aaaa\n\nbbbb", 100)).toEqual(["aaaa\n\nbbbb"]);
  });

  it("cuts a single oversized paragraph, having no better seam", () => {
    const chunks = chunkMrkdwn("x".repeat(25), 10);
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  it("drops blank runs rather than emitting empty sections", () => {
    expect(chunkMrkdwn("\n\n\n\naaa\n\n\n\n", 100)).toEqual(["aaa"]);
  });
});

describe("the write-up", () => {
  it("renders the approved markdown as Slack's own markup", () => {
    const text = allText(synthesis());
    expect(text).toContain("*What we settled*");
    expect(text).toContain("•  The ablation replicates at our scale");
    expect(text).not.toContain("## ");
  });

  it("keeps the attribution the markdown carried", () => {
    // Once the draft is prose, attribution is only what the prose says —
    // dropping it here would turn the lab's writing into anonymous writing.
    expect(allText(synthesis())).toContain("— Ana Ruiz, Ben Okafor");
  });

  it("puts the citation count next to the link that lets somebody check it", () => {
    const footer = textOf(synthesis().blocks.at(-1) as SlackBlock);
    expect(footer).toContain("Resting on 18 notes the lab wrote");
    expect(footer).toContain(SESSION_URL);
  });

  it("says when it is a correction rather than a first posting", () => {
    expect(allText(synthesis({ revised: true }))).toContain("Revised write-up");
    expect(allText(synthesis())).toContain("What the lab worked out");
    expect(allText(synthesis())).not.toContain("Revised");
  });

  it("packs a long write-up into sections rather than a block per line", () => {
    // An approved write-up may run to 40 000 characters
    // (`MAX_APPROVED_LENGTH`). At ~2800 characters a section that is about
    // fifteen blocks, which is why the ceiling below is not reached by prose
    // however long it gets — the packing is what keeps it out of reach.
    const huge = synthesis({
      markdown: Array.from({ length: 500 }, (_, n) => `- point ${n}`).join("\n"),
    });
    expect(huge.blocks.length).toBeLessThanOrEqual(50);
    expect(allText(huge)).toContain("•  point 0");
    expect(allText(huge)).toContain("•  point 499");
  });
});

// --- The ceiling ------------------------------------------------------------

describe("Slack's block ceiling", () => {
  it("trims the middle and says so, keeping the way back in", () => {
    // Reached by structure rather than by length: a section per heading, and
    // enough headings. Prose alone cannot get here (see above), which is
    // precisely why this is asserted directly instead of hoped for.
    const many = brief({
      sections: Array.from({ length: 60 }, (_, n) => ({
        heading: `Section ${n}`,
        items: [`a line in section ${n}`],
        droppedCount: 0,
      })),
    });
    expect(many.blocks.length).toBeLessThanOrEqual(50);
    expect(allText(many)).toContain("too long for Slack");
    // The headline survives, because a trimmed post still has to say what it
    // is; the link survives, because it is what makes the rest recoverable.
    expect(many.blocks[0]?.type).toBe("header");
    expect(textOf(many.blocks.at(-1) as SlackBlock)).toContain(SESSION_URL);
  });

  it("leaves an ordinary message alone", () => {
    expect(allText(brief())).not.toContain("too long for Slack");
  });
});
