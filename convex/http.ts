import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { decideSharedPdf, isWriteConflict } from "../lib/shares/pdf-order";

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
/**
 * The share routes' own block.
 *
 * Identical to the authed one except for what is missing: no
 * `Access-Control-Allow-Headers: Authorization`. Reusing the block next door
 * advertised a credential header on a route that accepts none, which is a
 * small lie in a place where the whole argument is that this door has a
 * different key — and an invitation to some future caller to try attaching a
 * session to it.
 */
const SHARED_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

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

/** The same, minus the credential header the share routes do not accept. */
function refuseShared(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      ...SHARED_CORS_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
    },
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

/* -------------------------------------------------------------------------
 * PDF delivery for a share link
 * ---------------------------------------------------------------------- */

/**
 * `GET /shared-pdf?token=…` — the same bytes, for somebody with no account.
 *
 * A second door with its own key, rather than a hole in the first one. The
 * route above is untouched: it still demands a bearer header, and no share
 * token will ever make it answer. This one takes a share token and nothing
 * else, and `shares.pdfForShare` re-runs the whole gate on every request —
 * token exists, share not revoked, share is of a paper, paper still in the lab
 * the share names, paper still has a file. A link taken down stops serving the
 * PDF at the same moment it stops serving the page.
 *
 * ## Why a token in a URL is not the thing this route was built to avoid
 *
 * The authed route's doc comment above is emphatic that a permanent
 * unauthenticated link to a stored file is unacceptable, and it is right. The
 * difference here is what the credential *is*. A bearer token is a member's
 * whole session: leaking one hands over their labs, their private notes, and
 * the ability to write. A share token is a capability for one artifact that
 * somebody deliberately made public, it grants read and nothing else, and it
 * can be revoked in one press without touching anything else the member has.
 * Putting a session token in a URL would be a mistake of a different kind, and
 * this route does not do it: it accepts no `Authorization` header at all, so
 * there is no bearer credential anywhere near it to reuse or confuse.
 *
 * `X-Robots-Tag` because a PDF is a document a crawler indexes on its own
 * terms — the page's `<meta name="robots">` protects the page and says nothing
 * about a file fetched from another origin.
 *
 * On what is and is not recorded, precisely — the loose version of this
 * sentence was wrong. Margin writes nothing about this request: no row, no
 * ledger entry, no counter that could say who came. What Margin does not
 * control is the transport. The token travels as a query parameter, so it
 * appears in Convex's own HTTP request logs and in any intermediary that logs
 * URLs, and **revocation does not reach log storage** — taking the link down
 * stops it working everywhere that matters and does not unwrite it from a log
 * line. That is the cost of a capability in a URL, it is the same cost every
 * unguessable link has, and it is why the token is scoped to one artifact and
 * grants read only.
 *
 * The rate window in `shares.admitShare` is the one thing written on this
 * path, and it is keyed by the share rather than the reader — see the table's
 * own comment in `schema.ts`.
 */
http.route({
  path: "/shared-pdf",
  method: "OPTIONS",
  handler: httpAction(
    async () =>
      new Response(null, { status: 204, headers: SHARED_CORS_HEADERS }),
  ),
});

http.route({
  path: "/shared-pdf",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = new URL(request.url).searchParams.get("token");

    // The order is `decideSharedPdf`'s, not this handler's — see that module
    // for why each question is where it is. The short version: nothing that
    // was going to fail anyway is ever counted against the link's ceiling, and
    // a revocation landing mid-request is a 404 rather than a "try later".
    const outcome = await decideSharedPdf(token, {
      lookup: (t) => ctx.runQuery(internal.shares.pdfForShare, { token: t }),
      blob: (delivery) => ctx.storage.get(delivery.storageId),
      admit: async (t) => {
        try {
          return await ctx.runMutation(internal.shares.admitShare, { token: t });
        } catch (error) {
          // Only the one failure this route knows how to answer. Convex
          // exhausting its retries on the counter means the link is genuinely
          // being hammered, and "busy" is the true thing to say. Every other
          // error is a fault, and dressing a fault up as "come back later" is
          // exactly what this branch deleted from the page path — the reader
          // would keep coming back to something that was never going to work.
          if (isWriteConflict(error)) {
            return "busy";
          }
          throw error;
        }
      },
    });

    if (outcome.status === 400) {
      return refuseShared(400, "Ask for a paper.");
    }
    if (outcome.status === 404) {
      return refuseShared(404, "No such paper.");
    }
    if (outcome.status === 429) {
      return refuseShared(429, "This link is busy. Try again shortly.");
    }
    const { blob, title } = outcome;

    return new Response(blob, {
      status: 200,
      headers: {
        ...SHARED_CORS_HEADERS,
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${headerFilename(title)}"`,
        // `no-store` for the reason the authed route gives — the check on
        // every request is what protects the file, so a copy of the bytes in a
        // shared cache under this URL would outlive the revocation.
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  }),
});

export default http;
