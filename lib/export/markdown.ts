import { citationNumbering } from "../citations/numbering";

/**
 * The canonical section order, and a heading for a section whose own is
 * missing.
 *
 * Exported, and imported by the session's write-up component rather than
 * restated there, because this array is not a layout preference — it *is* the
 * citation numbering rule. Notes are numbered by first appearance walking
 * these sections, so a second copy that drifted by one line would renumber the
 * screen and not the download, and "Note 3" would mean two different notes in
 * two artifacts a reader is holding side by side. That is the exact defect
 * this file was already written to prevent; one array is what actually
 * prevents it.
 */
export const SECTION_ORDER = [
  { key: "summary", fallback: "What the session was about" },
  { key: "open-questions", fallback: "Open questions" },
  { key: "critiques-and-methods", fallback: "Critiques and methods" },
  { key: "connections", fallback: "Connections" },
  { key: "next-reading", fallback: "What to read next" },
] as const;

type SynthesisSectionKey = (typeof SECTION_ORDER)[number]["key"];

export type GeneratedSynthesisSection<A extends string = string> = {
  key: SynthesisSectionKey;
  heading: string;
  items: readonly {
    text: string;
    attribution: readonly string[];
    annotationIds: readonly A[];
  }[];
};

type SessionWriteUpInput<A extends string> = {
  title: string;
  approvedSynthesis?: string;
  generatedSections?: readonly GeneratedSynthesisSection<A>[];
  visibleAnnotationIds?: ReadonlySet<A>;
};

const WITHDRAWN_ITEM_TEXT =
  "A line here rested on notes that are no longer shared.";
const PARTIAL_ITEM_TEXT =
  "Some of the notes behind this are no longer shared.";

function escapeMarkdownInline(value: string): string {
  return value.replace(/([\\`*_[\]<>#|])/g, "\\$1");
}

function markdownItem<A extends string>(
  item: GeneratedSynthesisSection<A>["items"][number],
  visibleAnnotationIds: ReadonlySet<A>,
  numbering: ReadonlyMap<A, number>,
): string {
  const cited = item.annotationIds.filter((id) => visibleAnnotationIds.has(id));
  const withdrawn = item.annotationIds.length > 0 && cited.length === 0;
  const partial = cited.length < item.annotationIds.length;
  const text = withdrawn
    ? `_${WITHDRAWN_ITEM_TEXT}_`
    : escapeMarkdownInline(item.text).replaceAll("\n", "\n  ");
  const metadata: string[] = [];

  if (!withdrawn) {
    if (!partial && item.attribution.length > 0) {
      metadata.push(escapeMarkdownInline(item.attribution.join(", ")));
    }
    for (const id of cited) {
      const number = numbering.get(id);
      if (number !== undefined) {
        metadata.push(`[Note ${number}](#note-${id})`);
      }
    }
    if (partial) {
      metadata.push(`_${PARTIAL_ITEM_TEXT}_`);
    }
  }

  return metadata.length > 0
    ? `- ${text}\n\n  ${metadata.join(" · ")}`
    : `- ${text}`;
}

/**
 * The approved string is already the lab's authored Markdown. Generated text
 * follows the same citation/redaction thresholds as the session component.
 *
 * Citation numbers are built here, from the sections this function was already
 * handed, in the canonical order it prints them — not passed in. The page
 * builds its map by the same rule from `SECTION_ORDER` above, which it imports
 * rather than repeats, so a downloaded .md and the screen it came from cannot
 * disagree about which note "Note 3" is: there is no argument to forget to
 * thread through, and no second ordering to keep in step.
 */
export function sessionWriteUpToMarkdown<A extends string = string>({
  title,
  approvedSynthesis,
  generatedSections,
  visibleAnnotationIds = new Set<A>(),
}: SessionWriteUpInput<A>): string {
  const titleLine = `# ${escapeMarkdownInline(title.trim())}`;
  if (approvedSynthesis !== undefined) {
    const approved = approvedSynthesis.trim();
    return approved.length > 0
      ? `${titleLine}\n\n${approved}\n`
      : `${titleLine}\n`;
  }

  const ordered = SECTION_ORDER.flatMap(({ key, fallback }) => {
    const section = generatedSections?.find((candidate) => candidate.key === key);
    return section === undefined || section.items.length === 0
      ? []
      : [{ section, fallback }];
  });

  // Over the visible citations only: a withdrawn note is redacted out of the
  // document, and a number spent on it would leave a hole in the sequence.
  const numbering = citationNumbering(
    ordered.flatMap(({ section }) =>
      section.items.map((item) => ({
        annotationIds: item.annotationIds.filter((id) =>
          visibleAnnotationIds.has(id),
        ),
      })),
    ),
  );

  const sections = ordered.map(({ section, fallback }) => {
    const heading = section.heading.length > 0 ? section.heading : fallback;
    return `## ${escapeMarkdownInline(heading)}\n\n${section.items
      .map((item) => markdownItem(item, visibleAnnotationIds, numbering))
      .join("\n\n")}`;
  });

  return sections.length > 0
    ? `${titleLine}\n\n${sections.join("\n\n")}\n`
    : `${titleLine}\n`;
}
