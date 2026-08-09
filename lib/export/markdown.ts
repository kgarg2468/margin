const SECTION_ORDER = [
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
    cited.forEach((id, index) => {
      metadata.push(`[Note ${index + 1}](#note-${id})`);
    });
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

  const sections: string[] = [];
  for (const { key, fallback } of SECTION_ORDER) {
    const section = generatedSections?.find((candidate) => candidate.key === key);
    if (section === undefined || section.items.length === 0) {
      continue;
    }
    const heading = section.heading.length > 0 ? section.heading : fallback;
    sections.push(
      `## ${escapeMarkdownInline(heading)}\n\n${section.items
        .map((item) => markdownItem(item, visibleAnnotationIds))
        .join("\n\n")}`,
    );
  }

  return sections.length > 0
    ? `${titleLine}\n\n${sections.join("\n\n")}\n`
    : `${titleLine}\n`;
}
