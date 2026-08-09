/**
 * Margin's three artifacts, written for Slack.
 *
 * A lab's channel is where its work is read, and the thing that makes a post
 * worth reading there is that it was *composed* for the channel. The tempting
 * shortcut is to take the markdown Margin already assembles — the brief's
 * sections, the approved write-up's prose — and hand it to an incoming webhook
 * as one `text` field. Slack renders that as a wall: `##` survives as two hash
 * marks, `- ` as a hyphen, and a write-up a person spent twenty minutes editing
 * arrives looking like a `cat` of a file.
 *
 * So every message here is Block Kit: a headline, a provenance line in small
 * grey type, rules between the parts, and exactly one link back into Margin at
 * the bottom. It reads like the product, and it reads like Slack.
 *
 * This module is pure. It knows nothing about a database, a webhook or a
 * `fetch` — `convex/slack.ts` is the plumbing, the way `convex/digests.ts` is
 * the plumbing under `lib/digest/engine.ts`. Every rule below is therefore
 * checkable in a unit test, which is the point: what lands in a lab's channel
 * is product surface, and it is the surface nobody on the team looks at again
 * after they write it.
 *
 * ## The constitution, restated for a channel
 *
 * `convex/email.guard.test.ts` asserts that no message Margin sends reaches for
 * a remote asset or reports that it was read. A Slack post is the same kind of
 * artifact — handed to a third party, unrecallable — and the same rules bind
 * it, so nothing here emits an `image` block, an `image_url`, an `icon_url` or
 * an `accessory`, and the only links are the ones built from `siteUrl()`.
 * `convex/slack.guard.test.ts` states that mechanically.
 *
 * ## Why everything is escaped
 *
 * Slack's markup is not markdown: `<https://x|click here>` is a link, and it is
 * three characters a lab member can type into a note. Every string that reaches
 * a block passes through `escapeSlack` first, so a member's words arrive as
 * their words. The same reasoning as `escapeHtml` in `convex/auth.ts`, and the
 * same discipline — one function, so it cannot be forgotten in the fourth
 * place.
 */

/* -------------------------------------------------------------------------
 * The block vocabulary — the four Margin uses, and no others
 * ---------------------------------------------------------------------- */

export type SlackTextObject =
  | { type: "plain_text"; text: string; emoji: false }
  | { type: "mrkdwn"; text: string };

export type SlackBlock =
  | { type: "header"; text: { type: "plain_text"; text: string; emoji: false } }
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "context"; elements: SlackTextObject[] }
  | { type: "divider" };

/** One incoming-webhook payload, exactly as it goes over the wire. */
export type SlackMessage = {
  /**
   * The notification line, and the fallback for a client that cannot render
   * blocks. Slack shows this in the sidebar and in a push notification, so it
   * is a sentence rather than a repeat of the headline.
   */
  text: string;
  blocks: SlackBlock[];
};

/* -------------------------------------------------------------------------
 * Bounds Slack itself imposes
 * ---------------------------------------------------------------------- */

/** A `header` block's text is capped by Slack at 150 characters. */
const MAX_HEADER_CHARS = 150;

/**
 * A `section`'s text is capped at 3000. Margin stops short of it so a long
 * write-up breaks between paragraphs rather than exactly on the limit.
 */
const MAX_SECTION_CHARS = 2800;

/** A `context` element is capped at 2000; nothing here comes close. */
const MAX_CONTEXT_CHARS = 900;

/**
 * How much of a display name a provenance line carries.
 *
 * The same unbounded field `convex/notifications.ts` had to cap for a subject
 * line: a name comes from a Google profile or from whatever somebody typed into
 * the sign-up form, and nothing in the product bounds it.
 */
const NAME_IN_CONTEXT = 60;

/**
 * Slack refuses a message with more than 50 blocks.
 *
 * Margin stops at 40 so there is always room for the divider and the footer,
 * whatever the artifact turned out to be. Past it a write-up is truncated with
 * a line saying so — a post that is silently missing its conclusions is worse
 * than one that admits where it stopped.
 */
const MAX_BLOCKS = 40;

/** How much of a paper's title a headline carries before it is elided. */
const TITLE_IN_HEADLINE = 90;

/* -------------------------------------------------------------------------
 * Text
 * ---------------------------------------------------------------------- */

/**
 * The three characters Slack reads as markup.
 *
 * Slack unescapes `&amp;`, `&lt;` and `&gt;` on the way in, in `plain_text` and
 * `mrkdwn` alike, so escaping is uniform and a member's `<` arrives as a `<`
 * rather than as the opening of a link. Nothing else needs escaping: `*` and
 * `_` are formatting a member is entitled to type, and the worst they can do is
 * embolden their own sentence.
 */
export function escapeSlack(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * At most `limit` characters *after* escaping, with an ellipsis if anything was
 * dropped.
 *
 * Measured on the escaped string rather than the source, because that is the
 * one Slack counts: a title of 150 ampersands is 750 characters by the time it
 * reaches a `header` block, and a bound computed before escaping is not a
 * bound. Built up a character at a time so a cut can never land inside an
 * entity and leave `&am` in a lab's channel.
 */
export function escapeWithin(value: string, limit: number): string {
  const whole = escapeSlack(value);
  if (whole.length <= limit) {
    return whole;
  }
  const ellipsis = "…";
  const budget = limit - ellipsis.length;
  let out = "";
  for (const character of value) {
    const next = escapeSlack(character);
    if (out.length + next.length > budget) {
      break;
    }
    out += next;
  }
  return `${out.trimEnd()}${ellipsis}`;
}

/** A link back into Margin, in the one syntax Slack has for one. */
export function slackLink(url: string, label: string): string {
  // The label is escaped and the URL is not: a `siteUrl()`-built link contains
  // no `&`, `<` or `>` (`convex/auth.ts` refuses an origin with a query on it,
  // and every path Margin builds is ids and slashes), and escaping it would
  // break the one thing the post exists to offer.
  return `<${url}|${escapeSlack(label)}>`;
}

/** One line of a bulleted list, in Slack's own bullet rather than a hyphen. */
function bullet(text: string): string {
  return `•  ${text}`;
}

/**
 * A moment, rendered in each reader's own timezone.
 *
 * Slack's `!date` command is the answer to a problem the rest of the product
 * solves by refusing to: `convex/schema.ts` stores `fromSessionAt` as an epoch
 * number precisely because "a date has a timezone and a reader, and the server
 * has neither". A channel has several readers, in several places — a lab with a
 * collaborator two timezones over is the ordinary case, not the exotic one —
 * and this is the one output medium that will do the conversion per reader if
 * it is asked.
 *
 * The fallback after the pipe is what a client that cannot expand it shows, so
 * it has to be a real date rather than a placeholder. UTC, spelled out, because
 * an unlabelled local time from a server with no locale is a wrong answer
 * dressed as a right one.
 *
 * Returns Slack markup, so it must not be escaped by its caller — the `<` and
 * `>` are the command.
 */
export function slackDate(atMs: number): string {
  const seconds = Math.floor(atMs / 1000);
  // `toUTCString` is fixed-format and contains no `|` or `>`, so it cannot
  // close the command it sits inside.
  const fallback = new Date(atMs).toUTCString();
  return `<!date^${seconds}^{date_long_pretty} at {time}|${fallback}>`;
}

/* -------------------------------------------------------------------------
 * Blocks
 * ---------------------------------------------------------------------- */

export function headerBlock(text: string): SlackBlock {
  return {
    type: "header",
    // `emoji: false` on purpose. A paper title containing `:100:` is a paper
    // title, not a reaction, and a lab that studies emoji shortcodes should not
    // have its headline redrawn by one.
    text: {
      type: "plain_text",
      text: escapeWithin(text, MAX_HEADER_CHARS),
      emoji: false,
    },
  };
}

/** A section, from text that has already been escaped and marked up. */
function sectionBlock(mrkdwn: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text: mrkdwn } };
}

/** The small grey line: provenance, counts, and the link home. */
function contextBlock(mrkdwn: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text: mrkdwn }] };
}

const divider: SlackBlock = { type: "divider" };

/**
 * A heading and its bullets, as one section rather than one block each.
 *
 * Slack puts a generous margin between blocks, so a section per bullet renders
 * a four-line list as half a screen. One section holds the whole list and the
 * heading it belongs to, which is also what keeps a sectioned brief inside the
 * block ceiling.
 *
 * Split across several sections when the list outruns `MAX_SECTION_CHARS`, with
 * the heading repeated on neither — a repeated heading reads as a second
 * section that says the same thing.
 */
function listSections(heading: string, lines: readonly string[]): SlackBlock[] {
  if (lines.length === 0) {
    return [];
  }
  const blocks: SlackBlock[] = [];
  let buffer = `*${escapeSlack(heading)}*`;
  for (const line of lines) {
    const candidate = `${buffer}\n${line}`;
    if (candidate.length > MAX_SECTION_CHARS) {
      blocks.push(sectionBlock(buffer));
      buffer = line;
      continue;
    }
    buffer = candidate;
  }
  blocks.push(sectionBlock(buffer));
  return blocks;
}

/**
 * Trim a message to the block ceiling, saying so when it had to.
 *
 * The footer is kept — it carries the link that makes the rest recoverable —
 * so what gets dropped is the middle, which is the only honest place to cut.
 */
function withinBlockLimit(blocks: readonly SlackBlock[]): SlackBlock[] {
  if (blocks.length <= MAX_BLOCKS) {
    return [...blocks];
  }
  const footer = blocks.slice(-2);
  const kept = blocks.slice(0, MAX_BLOCKS - footer.length - 1);
  return [
    ...kept,
    contextBlock("_This post was too long for Slack; the rest is in Margin._"),
    ...footer,
  ];
}

/** The last two blocks every message ends with: a rule, then where to go. */
function footer(url: string, label: string, note?: string): SlackBlock[] {
  const link = slackLink(url, label);
  const room = Math.max(MAX_CONTEXT_CHARS - link.length - 5, 0);
  return [
    divider,
    contextBlock(
      note === undefined || room === 0
        ? link
        : `${escapeWithin(note, room)}  ·  ${link}`,
    ),
  ];
}

/* -------------------------------------------------------------------------
 * The presenter's brief
 * ---------------------------------------------------------------------- */

export type BriefSectionInput = {
  heading: string;
  /** Already redacted and already filtered; every string is a member's line. */
  items: readonly string[];
  /** Candidates the per-section cap held back. */
  droppedCount: number;
};

/**
 * The brief, posted because its presenter signed it off.
 *
 * Sectioned the way the panel is sectioned, because the sections are the
 * feature — a presenter's four questions, each answered out of what the lab
 * already wrote. A section the cap trimmed says so in its own last line rather
 * than in a footnote nobody reads next to the thing it is about.
 */
export function composeBriefMessage(input: {
  paperTitle: string;
  /** How the meeting reads on a calendar, already formatted by the caller. */
  when: string;
  presenterName: string;
  approvedByName: string;
  sections: readonly BriefSectionInput[];
  citationCount: number;
  /** `${siteUrl()}/app/sessions/${sessionId}` */
  url: string;
}): SlackMessage {
  const title = escapeWithin(input.paperTitle, TITLE_IN_HEADLINE);
  const blocks: SlackBlock[] = [
    headerBlock(`The brief — ${input.paperTitle}`),
    // `when` is Slack markup and is deliberately not escaped; everything around
    // it is a person's name, which is.
    contextBlock(
      [
        input.when,
        `${escapeWithin(input.presenterName, NAME_IN_CONTEXT)} presenting`,
        `reviewed by ${escapeWithin(input.approvedByName, NAME_IN_CONTEXT)}`,
      ].join("  ·  "),
    ),
    divider,
  ];

  for (const section of input.sections) {
    const lines = section.items.map((item) =>
      bullet(escapeWithin(item, MAX_SECTION_CHARS - 8)),
    );
    if (section.droppedCount > 0) {
      lines.push(
        `_and ${section.droppedCount} more like ${section.droppedCount === 1 ? "it" : "them"}_`,
      );
    }
    blocks.push(...listSections(section.heading, lines));
  }

  const notes =
    input.citationCount === 1
      ? "Assembled from 1 note the lab wrote"
      : `Assembled from ${input.citationCount} notes the lab wrote`;
  blocks.push(...footer(input.url, "Open the session in Margin", notes));

  return {
    // The fallback line answers the only question a sidebar preview can: what
    // is this, and about what.
    // The fallback is bounded in both its variable parts, for the same reason
    // the context line is: a display name is whatever somebody typed into the
    // sign-up form, and a sidebar preview is not the place to find that out.
    text: `The brief for “${title}” — ${escapeWithin(input.presenterName, NAME_IN_CONTEXT)} presenting`,
    blocks: withinBlockLimit(blocks),
  };
}

/* -------------------------------------------------------------------------
 * The boundary post
 * ---------------------------------------------------------------------- */

/**
 * What the margin holds two hours before a meeting, addressed to the room.
 *
 * Deliberately not one member's digest. A `digests` row is one person's mail —
 * built against their own cursor, phrased with "you" — and posting one into a
 * shared channel would publish the very thing the privacy constitution refuses
 * to store an aggregate of. What goes to the channel is the part that is a fact
 * about the *paper*: the gold collisions in its margin, which exist whether or
 * not anybody has caught up on them.
 *
 * `lines` therefore arrives already rendered by `collisionLine` with no
 * recipient, so no line says "you" to a room.
 */
export function composeBoundaryMessage(input: {
  paperTitle: string;
  when: string;
  presenterName: string;
  lines: readonly string[];
  /** Lab-visible, un-withdrawn annotations on the paper right now. */
  annotationCount: number;
  /** `${siteUrl()}/app/library/${paperId}/read` */
  url: string;
}): SlackMessage {
  const title = escapeWithin(input.paperTitle, TITLE_IN_HEADLINE);
  const marks =
    input.annotationCount === 1
      ? "1 note in the margin"
      : `${input.annotationCount} notes in the margin`;

  const blocks: SlackBlock[] = [
    headerBlock(`Two hours out — ${input.paperTitle}`),
    contextBlock(
      [
        input.when,
        `${escapeWithin(input.presenterName, NAME_IN_CONTEXT)} presenting`,
        marks,
      ].join("  ·  "),
    ),
    divider,
  ];

  if (input.lines.length === 0) {
    // Worth posting anyway, and worth being plain about. "Nobody has argued
    // with anybody yet" two hours before a meeting is the most actionable
    // thing this post ever says.
    blocks.push(
      sectionBlock(
        "Nothing in the margin has collided yet — no two people have landed on the same passage from different directions.",
      ),
    );
  } else {
    blocks.push(
      ...listSections(
        "Where the margin has collided",
        input.lines.map((line) =>
          bullet(escapeWithin(line, MAX_SECTION_CHARS - 8)),
        ),
      ),
    );
  }

  blocks.push(...footer(input.url, "Read into the margin"));

  return {
    text: `Two hours until the session on “${title}” — ${marks}`,
    blocks: withinBlockLimit(blocks),
  };
}

/* -------------------------------------------------------------------------
 * The write-up
 * ---------------------------------------------------------------------- */

/**
 * The approved write-up's markdown, as Slack's markup.
 *
 * The stored artifact is markdown because a textarea is what makes it editable
 * (`synthesis.assembleMarkdown`), and this is the other end of that one-way
 * door. Three transformations and no more:
 *
 *   - `## Heading` becomes a bold line. Slack has no headings; bold is what it
 *     has, and a `##` left alone renders as two hash marks.
 *   - `- item` becomes a bullet. Slack renders `-` as a hyphen at the start of
 *     a line, which reads as a dash in a sentence rather than as a list.
 *   - Everything else is left as the approver typed it.
 *
 * Escaping happens first, on the raw line, and the structural rewrite runs over
 * the escaped text. That order matters: `#` and `-` survive escaping untouched,
 * while a `<` the approver typed is already inert by the time any `*` is added
 * around it.
 */
export function markdownToMrkdwn(markdown: string): string {
  return markdown
    .split("\n")
    .map((raw) => {
      const line = escapeSlack(raw.trimEnd());
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading !== null) {
        return `*${heading[1]}*`;
      }
      const item = /^\s*[-*]\s+(.*)$/.exec(line);
      if (item !== null) {
        return bullet(item[1] ?? "");
      }
      return line;
    })
    .join("\n");
}

/**
 * The longest escape `escapeSlack` can emit, in characters.
 *
 * `&amp;` is five; the six here is slack for a fourth entity showing up later
 * without this constant being revisited.
 */
const LONGEST_ENTITY = 6;

/**
 * How many characters of `text` may be taken without cutting an entity in half.
 *
 * At most `limit`, and less than that only when the character at the limit sits
 * inside an `&…;` escape that has not closed yet — in which case the cut backs
 * up to the `&` and the whole entity travels to the next chunk. Everything
 * reaching this function has already been through `escapeSlack`, so the only
 * ampersands present are ones we put there.
 */
function entitySafeCut(text: string, limit: number): number {
  if (text.length <= limit) {
    return text.length;
  }
  const window = text.slice(Math.max(0, limit - LONGEST_ENTITY), limit);
  const offset = window.lastIndexOf("&");
  if (offset === -1) {
    return limit;
  }
  const start = Math.max(0, limit - LONGEST_ENTITY) + offset;
  const closes = text.indexOf(";", start);
  if (closes !== -1 && closes < limit) {
    // The entity opened and closed inside the chunk. Nothing to back up for.
    return limit;
  }
  // `start` can only be 0 when the entire limit is one unterminated entity,
  // which needs a limit under six characters to arrange. Take the limit rather
  // than nothing, because a chunk of zero length is a loop that never ends.
  return start === 0 ? limit : start;
}

/**
 * Break already-converted mrkdwn into sections Slack will accept.
 *
 * Split on blank lines rather than on a character count, so a section boundary
 * falls between paragraphs. A single paragraph longer than the limit — an
 * approver who wrote one enormous block — is cut near the limit, because there
 * is no better seam in it; `entitySafeCut` keeps that cut from landing inside
 * an escape and rendering `&am` at the end of one section and `p;` at the start
 * of the next.
 */
export function chunkMrkdwn(
  mrkdwn: string,
  limit: number = MAX_SECTION_CHARS,
): string[] {
  const chunks: string[] = [];
  let buffer = "";
  for (const paragraph of mrkdwn.split(/\n{2,}/)) {
    const block = paragraph.trim();
    if (block.length === 0) {
      continue;
    }
    if (block.length > limit) {
      if (buffer.length > 0) {
        chunks.push(buffer);
        buffer = "";
      }
      let at = 0;
      while (at < block.length) {
        const take = entitySafeCut(block.slice(at), limit);
        chunks.push(block.slice(at, at + take));
        at += take;
      }
      continue;
    }
    const candidate = buffer.length === 0 ? block : `${buffer}\n\n${block}`;
    if (candidate.length > limit) {
      chunks.push(buffer);
      buffer = block;
      continue;
    }
    buffer = candidate;
  }
  if (buffer.length > 0) {
    chunks.push(buffer);
  }
  return chunks;
}

/**
 * The lab's record of a meeting, posted because a person approved it.
 *
 * This is the artifact the feature exists for. A journal club's output has
 * always been "we talked about it and Ana took some notes"; the write-up is the
 * thing that outlives the hour, and a channel is where the rest of the lab —
 * and the person who missed it — actually reads.
 *
 * The citation count is in the footer on purpose. It is the claim that makes
 * the prose worth trusting — every line came from something a member wrote and
 * can be opened — and it belongs next to the link that lets somebody check it.
 */
export function composeSynthesisMessage(input: {
  paperTitle: string;
  when: string;
  approvedByName: string;
  /** The approved text, as stored: markdown a person edited. */
  markdown: string;
  citationCount: number;
  revised: boolean;
  /** `${siteUrl()}/app/sessions/${sessionId}` */
  url: string;
}): SlackMessage {
  const title = escapeWithin(input.paperTitle, TITLE_IN_HEADLINE);
  const blocks: SlackBlock[] = [
    headerBlock(
      `${input.revised ? "Revised write-up" : "What the lab worked out"} — ${input.paperTitle}`,
    ),
    contextBlock(
      [
        input.when,
        `approved by ${escapeWithin(input.approvedByName, NAME_IN_CONTEXT)}`,
      ].join("  ·  "),
    ),
    divider,
  ];

  for (const chunk of chunkMrkdwn(markdownToMrkdwn(input.markdown))) {
    blocks.push(sectionBlock(chunk));
  }

  const cited =
    input.citationCount === 1
      ? "Resting on 1 note the lab wrote"
      : `Resting on ${input.citationCount} notes the lab wrote`;
  blocks.push(...footer(input.url, "Open the session in Margin", cited));

  return {
    text: `${input.revised ? "Revised write-up" : "Write-up"} for “${title}” — approved by ${escapeWithin(input.approvedByName, NAME_IN_CONTEXT)}`,
    blocks: withinBlockLimit(blocks),
  };
}
