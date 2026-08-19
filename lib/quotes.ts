/**
 * A quote lifted from a PDF text layer arrives with the paper's plumbing
 * still attached: linebreak whitespace, the bracketed citation markers that
 * mean something in the bibliography and nothing on a passage card, and the
 * spaces extraction leaves inside a word the typesetter broke. This trims a
 * quote for display as an address — enough to find the passage — preferring
 * to end where a sentence does.
 */
// Whitespace before the bracket is part of the pattern: a marker glued to a
// word, like the subscript in "x[0]", is the author's own notation, not a
// citation, and stripping it would put words in their mouth.
const DEBRIS = /\s+\[\d+(?:\s*[,–-]\s*\d+)*\]/g;

/**
 * A soft hyphen, and whatever the extractor left after it.
 *
 * U+00AD is by definition a *discretionary* hyphen: a mark saying "this word
 * may break here" that shows no glyph when it doesn't. So this character is
 * the proof the rule below lacks — its presence establishes that the break was
 * the typesetter's and the word underneath is whole, which makes closing it up
 * the one join that invents nothing. Trailing whitespace goes with it, since a
 * text layer will happily leave a space where the line ended.
 */
const SOFT_HYPHEN = /\u00ad\s*/g;

/**
 * The synthetic space inside a word the typesetter cut in half.
 *
 * `normalizePdfText` collapses the newline a paper was set with, because every
 * stored anchor offset counts characters in the result — so a word broken
 * across two lines reaches us as "assump- tion". That space is not in the
 * paper. Extraction put it there, and it is the only thing removed here.
 *
 * Closing the gap the rest of the way — "assump- tion" to "assumption" —
 * needs to know the hyphen was discretionary, and nothing in the syntax says
 * so. Extraction inserts a space between *every* pair of text items, so a real
 * compound split at an item or line boundary ("cost- effective",
 * "state- of-the-art") arrives looking exactly like a broken word, and a full
 * join would put "costeffective" on a wall in front of a lab. Verbatim
 * integrity beats cosmetic healing: a word the reader has to mend is a smaller
 * injury than a word we invented, so the hyphen character always survives and
 * the only thing ever deleted is whitespace that was never the author's.
 *
 * The exception is the suspended compound — "pre- and post-test", "three- to
 * five-year" — where the hyphen hangs on purpose and the space after it is the
 * author's punctuation rather than the extractor's.
 *
 * Either side may be any letter, not only a lowercase one. Papers are dense
 * with "anti- TNF", "non- Hodgkin" and "COVID- related", and a capital is no
 * evidence that a line did not break there. Since the hyphen survives either
 * way, the worst a wrong join can produce is "word-Word", which still reads as
 * the compound it probably is.
 *
 * The tail is a lookahead rather than a capture so that the letter ending one
 * break can begin the next: consuming it left "x- y- z" repaired to "x-y- z",
 * one break short of done.
 *
 * The exemption is case-blind for the same reason the letter classes are: a
 * heading suspends compounds too, and "PRE- AND POST-TEST" is the author's
 * whitespace as surely as its lowercase twin.
 */
const BROKEN_WORD =
  /(\p{L}[-\u2010\u2011])\s(?!(?:and|or|nor|to)\b)(?=\p{L})/giu;

/**
 * The repair that is only about how the text layer broke the words: soft
 * hyphens, whitespace, and the space inside a split word. Nothing in here is a
 * judgement about what belongs on a card, which is why the display pass and
 * the identity pass below can share it.
 */
function mendBreaks(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(BROKEN_WORD, "$1");
}

/**
 * A quote with the extraction plumbing taken off, for display, at whatever
 * length it is. `cleanQuote` is this plus a cap.
 */
export function healQuote(raw: string): string {
  return mendBreaks(raw.replace(SOFT_HYPHEN, "").replace(DEBRIS, ""));
}

/**
 * The same quote as an identity: what decides whether two anchors are the same
 * passage.
 *
 * Identity and display want different things from a quote, and the citation
 * markers are where they part company. On a card `[12]` is furniture — it
 * means something in the bibliography and nothing beside a passage — so
 * `healQuote` drops it. As identity it is *evidence*: "Result [12]" and
 * "Result [13]" are two different findings, and a key that strips both
 * collapses them into one group whose card then shows whichever anchor
 * happened to arrive first.
 *
 * So this mends the breaks and keeps the markers. Two members who selected one
 * sentence still meet however the text layer hyphenated it; two members who
 * selected different citations stay apart.
 */
export function keyQuote(raw: string): string {
  return mendBreaks(raw.replace(SOFT_HYPHEN, ""));
}

export function cleanQuote(raw: string, max: number): string {
  const flat = healQuote(raw);
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
