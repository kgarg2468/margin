/**
 * A quote lifted from a PDF text layer arrives with the paper's plumbing
 * still attached: linebreak whitespace and the bracketed citation markers
 * that mean something in the bibliography and nothing on a passage card.
 * This trims a quote for display as an address — enough to find the
 * passage — preferring to end where a sentence does.
 */
// Whitespace before the bracket is part of the pattern: a marker glued to a
// word, like the subscript in "x[0]", is the author's own notation, not a
// citation, and stripping it would put words in their mouth.
const DEBRIS = /\s+\[\d+(?:\s*[,–-]\s*\d+)*\]/g;

export function cleanQuote(raw: string, max: number): string {
  const flat = raw.replace(DEBRIS, "").replace(/\s+/g, " ").trim();
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
