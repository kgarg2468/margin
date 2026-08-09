import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";

/**
 * Convex Auth's HTTP endpoints (token exchange, OAuth callbacks, sign-out)
 * live on the deployment's `.convex.site` origin.
 */
const http = httpRouter();

auth.addHttpRoutes(http);

/* -------------------------------------------------------------------------
 * PDF delivery
 * ---------------------------------------------------------------------- */

/**
 * `GET /pdf?paperId=…` — the only way a PDF leaves this deployment.
 *
 * Margin used to hand the browser a `storage.getUrl(...)` link. That link is
 * permanent and unauthenticated: forwarding it, or pasting it into a chat,
 * gives the file to anyone, for as long as the file exists, with no lab
 * membership anywhere in the picture. A library meant to hold paywalled PDFs
 * cannot have that property, so the bytes now come through here, where the
 * caller is identified on every single request.
 *
 * The request carries the member's Convex Auth token as a bearer header —
 * the same token every query and mutation already travels with, put on the
 * request explicitly by our own code. That is the whole reason CORS below can
 * be permissive: there are no ambient credentials on this route for another
 * origin to ride. A page on evil.example cannot read a member's token out of
 * Margin's storage, so it cannot construct a request this route will answer.
 */

/**
 * Wide-open CORS, deliberately.
 *
 * This route has no cookie auth and no `credentials` mode — authorization is
 * a header our own JavaScript attaches, and a cross-origin page has no way to
 * obtain it. `Access-Control-Allow-Origin: *` therefore grants nothing; the
 * alternative, pinning to `SITE_URL`, buys no safety and breaks every preview
 * deployment and local origin that isn't the one configured.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization",
  "Access-Control-Max-Age": "86400",
};

/**
 * A `filename` a header can carry: quotes and control characters would break
 * the parse, and anything non-ASCII is not this header's business. The title
 * is a nicety for the browser's save dialog, so it degrades to a plain name
 * rather than growing an RFC 5987 encoding for it.
 */
function headerFilename(title: string): string {
  const cleaned = title
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/["\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? `${cleaned}.pdf` : "paper.pdf";
}

/** Every refusal says the same thing, so probing tells a stranger nothing. */
function refuse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

http.route({
  path: "/pdf",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: CORS_HEADERS })),
});

http.route({
  path: "/pdf",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const paperId = new URL(request.url).searchParams.get("paperId");
    if (paperId === null) {
      return refuse(400, "Ask for a paper.");
    }

    // Answered before the database is touched so an expired session reads as
    // "sign in again" rather than "that paper isn't yours", which is what the
    // membership check below would otherwise say to a member in good standing
    // whose token simply aged out mid-read.
    if ((await ctx.auth.getUserIdentity()) === null) {
      return refuse(401, "Not signed in.");
    }

    // `pdfForDelivery` throws for a paper that doesn't exist and for a lab the
    // caller isn't in; a `paperId` that isn't an id at all throws before it
    // even gets that far. All three are one answer on purpose — a prober must
    // not be able to tell an unreadable paper from an imaginary one.
    let delivery: { storageId: Id<"_storage">; title: string } | null;
    try {
      delivery = await ctx.runQuery(internal.papers.pdfForDelivery, {
        paperId: paperId as Id<"papers">,
      });
    } catch {
      return refuse(404, "No such paper.");
    }
    if (delivery === null) {
      return refuse(404, "No such paper.");
    }

    const blob = await ctx.storage.get(delivery.storageId);
    if (blob === null) {
      return refuse(404, "No such paper.");
    }

    // Nothing is recorded about this request. Not who asked, not which paper,
    // not when — the privacy constitution says the only evidence of
    // engagement Margin ever stores is an annotation someone chose to write,
    // and a fetch log is a read receipt with a different name on it.
    return new Response(blob, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${headerFilename(delivery.title)}"`,
        // The URL is not a secret — the membership check on every request is
        // what protects the file — so a copy of the bytes sitting in a shared
        // disk cache under that URL is exactly the leak this route exists to
        // close. It costs a re-download per open, which for a paper-sized PDF
        // is the cheaper half of the trade.
        "Cache-Control": "private, no-store",
      },
    });
  }),
});

export default http;
