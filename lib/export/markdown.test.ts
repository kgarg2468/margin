import { describe, expect, it } from "vitest";
import {
  sessionWriteUpToMarkdown,
  type GeneratedSynthesisSection,
} from "./markdown";

const sections: GeneratedSynthesisSection[] = [
  {
    key: "open-questions",
    heading: "Open questions",
    items: [
      {
        text: "Does the effect survive replication?",
        attribution: ["Grace Hopper"],
        annotationIds: ["visible-2"],
      },
    ],
  },
  {
    key: "summary",
    heading: "",
    items: [
      {
        text: "The lab focused on the sampling frame.",
        attribution: ["Ada Lovelace", "Grace Hopper"],
        annotationIds: ["visible-1", "visible-2"],
      },
      {
        text: "This sentence must not leave the lab.",
        attribution: ["A Former Member"],
        annotationIds: ["withdrawn-1"],
      },
      {
        text: "One supporting note remains shared.",
        attribution: ["Ada Lovelace", "A Former Member"],
        annotationIds: ["visible-1", "withdrawn-2"],
      },
    ],
  },
];

describe("sessionWriteUpToMarkdown", () => {
  it("prefers an approved write-up and preserves its authored Markdown", () => {
    expect(
      sessionWriteUpToMarkdown({
        title: "Weekly session",
        approvedSynthesis: "## Our conclusion\n\n**Keep this wording.**",
        generatedSections: sections,
        visibleAnnotationIds: new Set(["visible-1", "visible-2"]),
      }),
    ).toBe(
      "# Weekly session\n\n## Our conclusion\n\n**Keep this wording.**\n",
    );
  });

  it("orders generated sections canonically and matches rendered redactions", () => {
    expect(
      sessionWriteUpToMarkdown({
        title: "Memory #1",
        generatedSections: sections,
        visibleAnnotationIds: new Set(["visible-1", "visible-2"]),
      }),
    ).toBe(
      "# Memory \\#1\n\n" +
        "## What the session was about\n\n" +
        "- The lab focused on the sampling frame.\n\n" +
        "  Ada Lovelace, Grace Hopper · [Note 1](#note-visible-1) · [Note 2](#note-visible-2)\n\n" +
        "- _A line here rested on notes that are no longer shared._\n\n" +
        "- One supporting note remains shared.\n\n" +
        "  [Note 1](#note-visible-1) · _Some of the notes behind this are no longer shared._\n\n" +
        "## Open questions\n\n" +
        "- Does the effect survive replication?\n\n" +
        // Numbered across the whole document, not inside one bullet: this is
        // the same note the summary cited second, so it is Note 2 here too.
        "  Grace Hopper · [Note 2](#note-visible-2)\n",
    );
  });

  it("numbers a note once for the whole document, in display order", () => {
    const markdown = sessionWriteUpToMarkdown({
      title: "Numbering",
      generatedSections: [
        {
          key: "connections",
          heading: "Connections",
          items: [
            { text: "Third.", attribution: [], annotationIds: ["c", "a"] },
          ],
        },
        {
          key: "summary",
          heading: "Summary",
          items: [
            { text: "First.", attribution: [], annotationIds: ["a"] },
            { text: "Second.", attribution: [], annotationIds: ["b", "a"] },
          ],
        },
      ],
      visibleAnnotationIds: new Set(["a", "b", "c"]),
    });

    // `summary` leads `connections` in the canonical order, so the numbers
    // follow the reader rather than the array: a=1, b=2, c=3 — and `a` keeps
    // its 1 in all three lines that rest on it.
    expect(markdown).toBe(
      "# Numbering\n\n" +
        "## Summary\n\n" +
        "- First.\n\n  [Note 1](#note-a)\n\n" +
        "- Second.\n\n  [Note 2](#note-b) · [Note 1](#note-a)\n\n" +
        "## Connections\n\n" +
        "- Third.\n\n  [Note 3](#note-c) · [Note 1](#note-a)\n",
    );
  });

  it("does not spend a number on a citation it never prints", () => {
    // A withdrawn note is redacted out of the document, so numbering it would
    // leave the reader a hole — "Note 1 · Note 3" — where the second citation
    // was never drawn.
    const markdown = sessionWriteUpToMarkdown({
      title: "Gaps",
      generatedSections: [
        {
          key: "summary",
          heading: "Summary",
          items: [
            {
              text: "Partly withdrawn.",
              attribution: [],
              annotationIds: ["gone", "here"],
            },
            { text: "Still shared.", attribution: [], annotationIds: ["also"] },
          ],
        },
      ],
      visibleAnnotationIds: new Set(["here", "also"]),
    });

    expect(markdown).toContain("[Note 1](#note-here)");
    expect(markdown).toContain("[Note 2](#note-also)");
  });

  it("writes a heading-only document when no synthesis exists", () => {
    expect(sessionWriteUpToMarkdown({ title: "An empty record" })).toBe(
      "# An empty record\n",
    );
  });
});
