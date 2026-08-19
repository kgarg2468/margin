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
 * 3. **The bytes exist — metadata only.** Before admission, deliberately.
 *    Admitting first meant a paper whose stored file had gone missing spent a
 *    counter increment and then 404'd anyway: a request that costs the link
 *    part of its ceiling and delivers nothing. Asking costs a metadata read;
 *    no bytes move.
 * 4. **Admission.** The last gate, so nothing that was going to fail anyway is
 *    ever counted against the link.
 * 5. **The download, after admission.** The split between 3 and 5 is the whole
 *    point of the guard. Fetching the file before deciding whether to serve it
 *    meant a refused request cost exactly as much bandwidth as a served one —
 *    a throttle that spent the resource it was protecting.
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
  /**
   * Does the stored file exist? Metadata only — **no bytes move here.**
   *
   * Separate from `download` because collapsing the two is what made the
   * throttle pay for the thing it exists to prevent: a refused request had
   * already pulled the whole PDF down before anybody asked whether to serve
   * it, so every 429 cost exactly the bandwidth a 200 costs. The existence
   * question still has to be asked before admission — a file missing from
   * storage must 404 without spending the link's ceiling — so it is asked the
   * cheap way, and the expensive way happens only once for a request that is
   * actually going to be answered.
   */
  exists: (delivery: Delivery) => Promise<boolean>;
  /** The counter, which is also the last liveness check. */
  admit: (token: string) => Promise<Admission>;
  /** The bytes. Reached only by a request that has already been admitted. */
  download: (delivery: Delivery) => Promise<Blob | null>;
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

  if (!(await steps.exists(delivery))) {
    return { status: 404 };
  }

  const admission = await steps.admit(token);
  if (admission === "dead") {
    return { status: 404 };
  }
  if (admission === "busy") {
    return { status: 429 };
  }

  const blob = await steps.download(delivery);
  // Storage lost the file between the metadata read and the fetch. Vanishingly
  // rare, and still a 404 rather than a crash — the increment it cost is the
  // price of having asked in the right order.
  if (blob === null) {
    return { status: 404 };
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
