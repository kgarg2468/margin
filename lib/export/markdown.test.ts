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
        "  Grace Hopper · [Note 1](#note-visible-2)\n",
    );
  });

  it("writes a heading-only document when no synthesis exists", () => {
    expect(sessionWriteUpToMarkdown({ title: "An empty record" })).toBe(
      "# An empty record\n",
    );
  });
});
