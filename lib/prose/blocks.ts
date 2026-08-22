/**
 * Markdown, as much of it as Margin's write-up surfaces promise.
 *
 * The approval editor hands people a markdown draft, so anything that renders
 * an approved copy has to understand headings and bullets or the `##` a person
 * never touched shows up in the lab's record. It stops there deliberately: a
 * real markdown pipeline is a dependency and an HTML-injection surface, in
 * exchange for emphasis marks nobody has asked for. Anything it does not
 * recognise is a paragraph — the text always survives.
 *
 * It lives here, rather than beside the session's own renderer where it was
 * written, because a share link now renders the same approved copy to a
 * stranger. Two copies of a parser whose whole job is to not build HTML out of
 * user input is two places for one of them to grow a feature, and the one that
 * grows it would be the one facing the open web.
 */

/** A block of an approved copy, in the order it was written. */
export type Block =
  | { kind: "heading"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "paragraph"; text: string };

export function toBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;

    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading?.[1] !== undefined) {
      blocks.push({ kind: "heading", text: heading[1] });
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet?.[1] !== undefined) {
      const last = blocks.at(-1);
      if (last?.kind === "list") {
        last.items.push(bullet[1]);
      } else {
        blocks.push({ kind: "list", items: [bullet[1]] });
      }
      continue;
    }

    blocks.push({ kind: "paragraph", text: line });
  }
  return blocks;
}
