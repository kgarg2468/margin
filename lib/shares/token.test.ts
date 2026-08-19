import { describe, expect, it } from "vitest";
import {
  SHARE_TOKEN_ALPHABET,
  SHARE_TOKEN_BITS,
  SHARE_TOKEN_LENGTH,
  looksLikeShareToken,
  mintShareToken,
  sharePath,
} from "./token";

/**
 * A share token is the whole of the permission.
 *
 * There is no second factor behind it, no session, and — by design — nobody to
 * ask. So the only thing standing between a stranger and a lab's margin is how
 * hard the string is to guess, and these tests are what hold this file to the
 * arithmetic written in it. If they fail, the endpoint is brute-forceable.
 */

describe("mintShareToken", () => {
  it("is the declared length, drawn from the declared alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const token = mintShareToken();
      expect(token).toHaveLength(SHARE_TOKEN_LENGTH);
      for (const symbol of token) {
        expect(SHARE_TOKEN_ALPHABET).toContain(symbol);
      }
    }
  });

  it("carries at least 128 bits of randomness", () => {
    // The bar for a bearer secret that lives on the open web indefinitely.
    // Asserted from the alphabet and the length rather than from the constant,
    // so shortening either one fails here rather than quietly halving the
    // search space a scanner has to cover.
    expect(SHARE_TOKEN_ALPHABET).toHaveLength(32);
    const bits = SHARE_TOKEN_LENGTH * Math.log2(SHARE_TOKEN_ALPHABET.length);
    expect(bits).toBe(SHARE_TOKEN_BITS);
    expect(bits).toBeGreaterThanOrEqual(128);
  });

  it("uses an alphabet with no ambiguous characters in it", () => {
    // These get read off a projector and out of a chat window. A token that
    // cannot be transcribed is a link that gets reported as broken.
    for (const confusable of ["l", "o", "0", "1"]) {
      expect(SHARE_TOKEN_ALPHABET).not.toContain(confusable);
    }
    expect(new Set(SHARE_TOKEN_ALPHABET).size).toBe(
      SHARE_TOKEN_ALPHABET.length,
    );
  });

  it("does not repeat itself", () => {
    // Not a randomness test — it cannot be — but it does catch the failure
    // that matters: a mint that has stopped drawing and started returning a
    // constant, which would make every share in the deployment the same link.
    const drawn = new Set(Array.from({ length: 500 }, mintShareToken));
    expect(drawn.size).toBe(500);
  });
});

describe("looksLikeShareToken", () => {
  it("accepts what the minter makes", () => {
    expect(looksLikeShareToken(mintShareToken())).toBe(true);
  });

  it("refuses the shapes a public endpoint actually receives", () => {
    const rejected = [
      "",
      "favicon.ico",
      // A Convex document id — the thing a share URL deliberately is not.
      // Wrong length and wrong alphabet, so it never reaches the index.
      "kd70j0msz0f9y43see31sj9ves8crxk7",
      mintShareToken().slice(0, SHARE_TOKEN_LENGTH - 1),
      `${mintShareToken()}a`,
      mintShareToken().toUpperCase(),
      // 26 characters, but two of them (`l`, `o`) are not in the alphabet.
      "abcdefghijklmnopqrstuvwx23",
      "../../etc/passwd",
    ];
    for (const candidate of rejected) {
      expect(looksLikeShareToken(candidate), candidate).toBe(false);
    }
  });

  it("still lets a well-formed stranger through to the index", () => {
    // The check is a cheap filter, not an authorization decision, and it must
    // not be mistaken for one: anything shaped like a token gets as far as
    // `by_token`, and the index is what says no.
    expect(looksLikeShareToken("abcdefghijkmnpqrstuvwxyz23")).toBe(true);
  });
});

describe("sharePath", () => {
  it("puts the token where the public route reads it", () => {
    expect(sharePath("abcdefghijkmnpqrstuvwxyz23")).toBe(
      "/s/abcdefghijkmnpqrstuvwxyz23",
    );
  });
});
