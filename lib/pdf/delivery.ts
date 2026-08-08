/**
 * Where a PDF comes from.
 *
 * Not from a URL any more. Margin's PDFs are served by a membership-checked
 * HTTP action (`convex/http.ts`), which means every fetch of a paper carries
 * the member's Convex Auth token and is authorized on arrival — there is no
 * longer any link to a paper that works on its own.
 *
 * That makes fetching a PDF slightly more than `fetch(url)`, and three places
 * need to do it: the reader hands the endpoint to pdf.js, the text-layer hook
 * pulls the bytes down to run pdf.js over them, and the paper page opens the
 * file in a tab. This module is the one description of how, and like
 * `extract.ts` beside it, it knows nothing about React and nothing about
 * Convex's client — the caller supplies the token, because the caller is the
 * one with a hook.
 */

/**
 * The `.convex.site` twin of a deployment's `.convex.cloud` API origin.
 *
 * Convex serves HTTP actions from a sibling domain rather than from the API
 * origin, and gives the browser only the latter (`NEXT_PUBLIC_CONVEX_URL`).
 * Deriving one from the other is the documented way across; a self-hosted
 * deployment that already points at something else is left alone.
 */
export function siteOriginFrom(convexUrl: string): string {
  return convexUrl.replace(/\/+$/, "").replace(/\.convex\.cloud$/, ".convex.site");
}

/** The address of a paper's PDF. Useless without a token, which is the point. */
export function pdfEndpoint(paperId: string): string {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error(
      "Missing NEXT_PUBLIC_CONVEX_URL, so there is no deployment to fetch the PDF from.",
    );
  }
  return `${siteOriginFrom(convexUrl)}/pdf?paperId=${encodeURIComponent(paperId)}`;
}

/**
 * The header that makes the endpoint answer.
 *
 * pdf.js takes this as `httpHeaders` and `fetch` as `headers`, so both routes
 * through this module spell authorization the same way.
 */
export function pdfAuthHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Say what a refused fetch means in a sentence a researcher can act on.
 *
 * A 401 is not the member's fault and not the file's — it is a token that
 * aged out — and telling them the PDF is broken would send them to re-upload
 * a perfectly good file.
 */
function describeStatus(status: number): string {
  if (status === 401) {
    return "Your session has expired. Sign in again and the paper will open.";
  }
  if (status === 404) {
    return "That paper's file isn't in a library you can see.";
  }
  return `The stored file came back ${status}.`;
}

/**
 * The PDF's bytes, for the callers that need them in hand rather than
 * streamed into a viewer — text extraction, and opening the file in a tab.
 */
export async function fetchPdfBytes(
  paperId: string,
  token: string | null,
): Promise<ArrayBuffer> {
  if (token === null) {
    throw new Error("Sign in again and the paper will open.");
  }
  const response = await fetch(pdfEndpoint(paperId), {
    headers: pdfAuthHeaders(token),
  });
  if (!response.ok) {
    // Without this, an error page's body goes to pdf.js and comes back as
    // "couldn't read that PDF" — which blames the file for the fetch.
    throw new Error(describeStatus(response.status));
  }
  return await response.arrayBuffer();
}
