/**
 * A quote lifted from a PDF text layer arrives with the paper's plumbing
 * still attached: linebreak whitespace, the bracketed citation markers that
 * mean something in the bibliography and nothing on a passage card, and the
 * hyphens the typesetter put in to make a line fit. This trims a quote for
 * display as an address — enough to find the passage — preferring to end
 * where a sentence does.
 */
// Whitespace before the bracket is part of the pattern: a marker glued to a
// word, like the subscript in "x[0]", is the author's own notation, not a
// citation, and stripping it would put words in their mouth.
const DEBRIS = /\s+\[\d+(?:\s*[,–-]\s*\d+)*\]/g;

/**
 * A soft hyphen is a *suggestion* that a word may break here. It carries no
 * glyph, so it is never anything but debris in a string being read.
 */
const SOFT_HYPHEN = /\u00ad/g;

/**
 * A word the typesetter cut in half.
 *
 * `normalizePdfText` collapses the newline the paper was set with, because
 * every stored anchor offset counts characters in the result — so a word
 * broken across two lines reaches us as "assump- tion", and the projector
 * shows the lab a hyphen the author never typed.
 *
 * The space is the tell. A hyphen somebody *wrote* has no space after it:
 * "well-known" comes out of the text layer whole, on one line or two. The one
 * common exception is the suspended compound — "pre- and post-test", "intra-
 * or inter-subject" — where the hyphen hangs on purpose and what follows is a
 * conjunction rather than the rest of the word.
 *
 * What is left over is genuinely ambiguous and no rule settles it: a line that
 * happened to break at a compound's own hyphen ("self- organising") is
 * indistinguishable from one that broke inside a word, and this closes both.
 * It errs that way deliberately — breaking mid-word is far and away the
 * commoner event in a two-column paper, and a lab reading "selforganising"
 * once is a better outcome than a board that shows "assump- tion" every time.
 */
const BROKEN_WORD = /(\p{Ll})[-\u2010\u2011]\s(?!(?:and|or|nor|to)\b)(\p{Ll})/gu;

export function cleanQuote(raw: string, max: number): string {
  const flat = raw
    .replace(SOFT_HYPHEN, "")
    .replace(DEBRIS, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(BROKEN_WORD, "$1$2");
  if (flat.length <= max) {
    return flat;
  }
  const head = flat.slice(0, max);
  // The last sentence end that fits — but only when it leaves enough of the
  // quote to be an address; "Dr." three characters in is not a resting place.
  const sentenceEnd = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("? "),
    head.lastIndexOf("! "),
  );
  if (sentenceEnd >= max * 0.4) {
    return head.slice(0, sentenceEnd + 1);
  }
  const wordEnd = head.lastIndexOf(" ");
  return `${(wordEnd > 0 ? head.slice(0, wordEnd) : head).trimEnd()}…`;
}
