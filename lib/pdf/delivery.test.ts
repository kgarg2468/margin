import { describe, expect, it } from "vitest";
import { pdfAuthHeaders, siteOriginFrom } from "./delivery";

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
