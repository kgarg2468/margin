import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PdfAuthError,
  fetchPdfBytes,
  pdfAuthHeaders,
  siteOriginFrom,
} from "./delivery";

/**
 * The one piece of PDF delivery that is worth a test rather than a browser:
 * getting from the API origin the client is given to the origin HTTP actions
 * are actually served from. Get this wrong and every PDF in the product 404s
 * — or worse, silently asks the wrong deployment — and the failure looks like
 * a broken file rather than a broken URL.
 */
describe("siteOriginFrom", () => {
  it("crosses from the API origin to the HTTP-action origin", () => {
    expect(siteOriginFrom("https://elegant-lemur-123.convex.cloud")).toBe(
      "https://elegant-lemur-123.convex.site",
    );
  });

  it("does not care about a trailing slash", () => {
    expect(siteOriginFrom("https://elegant-lemur-123.convex.cloud/")).toBe(
      "https://elegant-lemur-123.convex.site",
    );
  });

  it("leaves an origin that is already somewhere else alone", () => {
    // A self-hosted deployment serves both from one host; rewriting it would
    // point the browser at a domain that does not exist.
    expect(siteOriginFrom("https://convex.margin.internal")).toBe(
      "https://convex.margin.internal",
    );
  });

  it("only rewrites the suffix, never a name that merely contains it", () => {
    expect(siteOriginFrom("https://convex.cloud.example.org")).toBe(
      "https://convex.cloud.example.org",
    );
  });
});

describe("pdfAuthHeaders", () => {
  it("spells the token the way the HTTP action reads it", () => {
    // `ctx.auth.getUserIdentity()` in a Convex HTTP action reads exactly this
    // header, in exactly this shape. A lower-case `bearer` is not accepted.
    expect(pdfAuthHeaders("abc.def.ghi")).toEqual({
      Authorization: "Bearer abc.def.ghi",
    });
  });
});

/**
 * Which failures are the *session's* fault and which are the *file's*.
 *
 * This is not a taxonomy for its own sake. `useTextLayer` answers a failed
 * extraction by calling `markIngestFailed`, which writes "this PDF cannot be
 * read" onto the paper permanently — and nothing ever retries a paper that
 * has already failed. So a token that had not arrived yet, or one that aged
 * out mid-read, must be distinguishable from a PDF that is genuinely
 * unreadable, or a perfectly good paper gets condemned by a race with
 * sign-in. `PdfAuthError` is that distinction, and these are the cases that
 * have to keep landing on the right side of it.
 */
describe("fetchPdfBytes", () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.NEXT_PUBLIC_CONVEX_URL = originalUrl;
  });

  /** Stand in for the endpoint, answering with one status. */
  function respondWith(status: number) {
    process.env.NEXT_PUBLIC_CONVEX_URL = "https://elegant-lemur-123.convex.cloud";
    const fetchMock = vi.fn(async () =>
      status === 200
        ? new Response(new Uint8Array([37, 80, 68, 70]), { status })
        : new Response("no", { status }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it("refuses without a token, and does not even reach the network", async () => {
    const fetchMock = respondWith(200);
    await expect(fetchPdfBytes("paper1", null)).rejects.toBeInstanceOf(
      PdfAuthError,
    );
    // The point of the guard: a request with no bearer would come back 401
    // and read as a broken file.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls an expired session a session problem, not a file problem", async () => {
    respondWith(401);
    await expect(fetchPdfBytes("paper1", "stale")).rejects.toBeInstanceOf(
      PdfAuthError,
    );
  });

  it("leaves every other refusal a plain failure", async () => {
    // A 404 or a 500 says nothing good about the file's availability, and
    // recording that the ingest failed is the correct response to both.
    for (const status of [404, 500]) {
      respondWith(status);
      const caught = await fetchPdfBytes("paper1", "good").catch(
        (error: unknown) => error,
      );
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(PdfAuthError);
    }
  });

  it("hands back the bytes when the endpoint answers", async () => {
    const fetchMock = respondWith(200);
    const bytes = await fetchPdfBytes("paper1", "good");
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://elegant-lemur-123.convex.site/pdf?paperId=paper1",
      { headers: { Authorization: "Bearer good" } },
    );
  });
});
