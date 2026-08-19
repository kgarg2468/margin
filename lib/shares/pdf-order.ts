/**
 * The order `/shared-pdf` asks its questions in, as a function rather than as
 * a shape in a handler.
 *
 * It lives here because the ordering *is* the security property, and a
 * property that only exists inside an `httpAction` is a property no test can
 * reach — the suite could drive `admitShare` directly and prove nothing about
 * whether the route calls it in the right place. Everything the route does
 * with the outside world arrives as a callback, so a test can hand it a
 * missing blob, a revocation landing mid-request, or an exhausted counter, and
 * assert what a stranger would actually receive.
 *
 * The order, and why each step is where it is:
 *
 * 1. **A token at all.** No token is a malformed request, not a missing paper.
 * 2. **The link and its artifact.** One 404 for a token never minted, a link
 *    revoked, a share of a write-up rather than a paper, and a paper with no
 *    file — a prober must not be able to tell those apart.
 * 3. **The bytes exist.** Before admission, deliberately. Admitting first meant
 *    a paper whose stored file had gone missing spent a counter increment and
 *    then 404'd anyway: a request that costs the link part of its ceiling and
 *    delivers nothing.
 * 4. **Admission, last.** The gate immediately before serving, so nothing that
 *    was going to fail anyway is ever counted against the link.
 *
 * And the answer admission gives has three values rather than two. A link
 * revoked between step 2 and step 4 is *dead*, not busy, and the route must
 * say 404 — the same thing it says about a token that never existed. Returning
 * 429 there would tell somebody whose link had just been taken down to try
 * again later, which is both false and an oracle: it distinguishes "revoked
 * a moment ago" from "never existed", which nothing here is allowed to do.
 */

/** What admission can say. `dead` is a revocation that landed mid-request. */
export type Admission = "ok" | "busy" | "dead";

/** What the route will send, decided before any of it is turned into bytes. */
export type SharedPdfOutcome<Blob> =
  | { status: 400 }
  | { status: 404 }
  | { status: 429 }
  | { status: 200; blob: Blob; title: string };

export type SharedPdfSteps<Delivery extends { title: string }, Blob> = {
  /** The share, its paper, and its stored file — or null for all of them. */
  lookup: (token: string) => Promise<Delivery | null>;
  /** The stored bytes. Null when the file is gone from storage. */
  blob: (delivery: Delivery) => Promise<Blob | null>;
  /** The counter, which is also the last liveness check. */
  admit: (token: string) => Promise<Admission>;
};

export async function decideSharedPdf<
  Delivery extends { title: string },
  Blob,
>(
  token: string | null,
  steps: SharedPdfSteps<Delivery, Blob>,
): Promise<SharedPdfOutcome<Blob>> {
  if (token === null) {
    return { status: 400 };
  }

  const delivery = await steps.lookup(token);
  if (delivery === null) {
    return { status: 404 };
  }

  const blob = await steps.blob(delivery);
  if (blob === null) {
    return { status: 404 };
  }

  const admission = await steps.admit(token);
  if (admission === "dead") {
    return { status: 404 };
  }
  if (admission === "busy") {
    return { status: 429 };
  }

  return { status: 200, blob, title: delivery.title };
}

/**
 * Is this the counter losing a race, or something actually broken?
 *
 * Narrow on purpose. An earlier version of the route caught *everything* from
 * the counter and answered 429, which would have hidden a genuine backend
 * fault behind a message telling the reader to come back — and they would
 * have, forever, to something that was never going to work. Only contention
 * gets that answer; everything else is a fault and should look like one.
 *
 * Matched on the message rather than on a class, because Convex signals this
 * by text: there is no exported error type to `instanceof`, and the thrown
 * value arrives at an `httpAction` as a plain `Error`. The strings below are
 * the two stable parts of that text — the documented error code in the link it
 * carries, and the phrase describing the retries running out. The test beside
 * this holds the verbatim message a deployment produced, because a matcher
 * for a string nobody checked is a matcher that quietly stops matching.
 */
export function isWriteConflict(error: unknown): boolean {
  const text =
    error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return (
    /docs\.convex\.dev\/error#1\b/.test(text) ||
    /on every subsequent retry/i.test(text) ||
    /OptimisticConcurrencyControlFailure/i.test(text)
  );
}
