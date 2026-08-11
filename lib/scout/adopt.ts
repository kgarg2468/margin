import { cleanQuote } from "../quotes";

/** One note a member is pointing at: who wrote on it, where, and what it marked. */
export type AdoptCitation = {
  authorName: string;
  pageIndex: number;
  quote: string;
};

/** Enough of a passage to recognise, short enough that it cannot become the reply. */
const MAX_QUOTE = 90;

/**
 * What a composer opens with when a member adopts a finding's citations.
 *
 * Pointers and nothing else. The finding's own sentences are a model's
 * paraphrase, and `annotations` is the human-speech table (design §3.1) — a
 * prefilled draft of machine prose is that rule broken with an extra step,
 * because what lands in the table afterwards has a person's name on it.
 *
 * What is carried is the *paper's* words: an author, a page, and the passage
 * each note marked. Not the notes' bodies — a reply that opens by quoting
 * three colleagues back at themselves is not a citation, it is a summary
 * somebody else wrote, and this composer is for the member's own answer.
 *
 * The blank lines come first so the cursor's natural home is above the
 * pointers, which is where the answer goes.
 */
export function adoptSeed(citations: readonly AdoptCitation[]): string {
  if (citations.length === 0) {
    return "";
  }
  const lines = citations.map(
    (one) =>
      `${one.authorName}, p. ${one.pageIndex + 1}: “${cleanQuote(one.quote, MAX_QUOTE)}”`,
  );
  return `\n\n${lines.join("\n")}`;
}
