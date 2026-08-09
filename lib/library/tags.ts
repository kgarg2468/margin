/**
 * Tags: the lab's own vocabulary for its shelf.
 *
 * A tag is not a personal bookmark. Anyone in the lab can put one on a paper
 * and anyone can take it off again, because the value of "methods" as a label
 * is that it means the same thing to everybody who reads it — a per-member tag
 * would be twelve private filing systems wearing one name.
 *
 * Which makes normalization the whole game. `Methods`, `methods ` and
 * `  METHODS` are one label that three people typed differently, and a
 * vocabulary that lists all three has already failed at the one thing it is
 * for. So there is exactly one canonical form — lowercased, trimmed, inner
 * whitespace collapsed — and it is applied on the way in rather than on the way
 * out, so the stored value and the compared value can never disagree.
 */

/** Long enough for "connections to our work", short enough to stay a label rather than a sentence. */
export const MAX_TAG_LENGTH = 32;

/**
 * Twelve is a shelf mark budget, not a storage limit. A paper wearing thirty
 * tags is a paper nobody can find by any of them, and the cap is the place the
 * product says so.
 */
export const MAX_TAGS_PER_PAPER = 12;

/**
 * A tag as it is stored and compared, or `""` for input that was never a tag.
 *
 * Control characters and commas are turned into spaces before anything else: a
 * comma is the separator the input splits on, so one surviving inside a tag
 * would produce a label that could never be typed again.
 */
export function normalizeTag(input: string): string {
  const collapsed = input
    .replace(/[\p{Cc},]/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  // Trimmed again after the cut: slicing a long label mid-word can leave a
  // trailing space, and a space is not a character a label should end on.
  return collapsed.slice(0, MAX_TAG_LENGTH).trim();
}

/**
 * A set of tags in canonical form: normalized, emptied of blanks, deduped, and
 * capped.
 *
 * First-seen order is kept rather than sorted. The order a member typed their
 * tags in is the only ordering information anyone has, and alphabetizing it
 * would throw that away to buy nothing — the vocabulary list does its own
 * sorting, by use.
 */
export function normalizeTags(inputs: readonly string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const input of inputs) {
    const tag = normalizeTag(input);
    if (tag.length === 0 || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    tags.push(tag);
    if (tags.length === MAX_TAGS_PER_PAPER) {
      break;
    }
  }
  return tags;
}

/**
 * Split what someone typed into tags. Commas and newlines separate; spaces do
 * not, because "open question" is one label rather than two.
 */
export function parseTagInput(input: string): string[] {
  return normalizeTags(input.split(/[,\n]/));
}

export type TagCount = { tag: string; count: number };

/**
 * The lab's vocabulary, commonest first.
 *
 * Ties break alphabetically rather than by whatever order the papers came back
 * in: a list that reshuffles itself every time a paper is added is a list you
 * cannot learn the shape of.
 */
export function tagVocabulary(
  papers: readonly { tags?: readonly string[] }[],
): TagCount[] {
  const counts = new Map<string, number>();
  for (const paper of papers) {
    for (const tag of normalizeTags(paper.tags ?? [])) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * What to offer while someone is typing a tag.
 *
 * Prefix matches lead, then matches from inside the word: a member typing
 * "meth" means "methods" long before they mean "cheap method", and ranking the
 * two together would bury the obvious answer under the clever one. Tags already
 * on the paper are left out — offering a label that is right there is offering
 * a no-op.
 */
export function suggestTags(
  vocabulary: readonly TagCount[],
  input: string,
  options: { exclude?: readonly string[]; limit?: number } = {},
): string[] {
  const limit = options.limit ?? 6;
  const exclude = new Set(normalizeTags(options.exclude ?? []));
  const query = normalizeTag(input);

  const available = vocabulary.filter(({ tag }) => !exclude.has(tag));
  if (query.length === 0) {
    return available.slice(0, limit).map(({ tag }) => tag);
  }

  const prefix = available.filter(({ tag }) => tag.startsWith(query));
  const inner = available.filter(
    ({ tag }) => !tag.startsWith(query) && tag.includes(query),
  );
  return [...prefix, ...inner].slice(0, limit).map(({ tag }) => tag);
}
