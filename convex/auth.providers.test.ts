import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emailIsConfigured, googleIsConfigured } from "./auth";

/**
 * The gate between "the operator set the keys" and "the provider exists".
 *
 * `convex/auth.ts` registers Google and the sign-in link only when their keys
 * are on the deployment, so that `signIn` for an unconfigured provider fails
 * with "provider not configured" instead of somewhere deep inside an OAuth
 * handshake. That promise is load-bearing for the whole setup runbook — it is
 * what makes a half-configured deployment diagnosable — and it is one `&&`
 * away from being false, so it is checked here rather than trusted.
 *
 * The empty string is the case that matters and the one an existence check
 * gets wrong. `npx convex env set AUTH_GOOGLE_ID ""` is a real thing an
 * operator does, and so is saving a blank dashboard field; both leave the
 * variable present. A blank client id is not a client id, and registering the
 * provider on the strength of one hands the reader Google's `invalid_client`
 * screen — the exact failure the gate exists to prevent.
 *
 * Both gates are read at module scope in `auth.ts`, but they are plain
 * functions over `process.env`, so this reads them the same way the module
 * does without needing to re-import it per case.
 */

const KEYS = [
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "RESEND_API_KEY",
] as const;

let saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("googleIsConfigured", () => {
  it("is false on a deployment with neither key", () => {
    expect(googleIsConfigured()).toBe(false);
  });

  it("is true only when both halves of the client are present", () => {
    process.env.AUTH_GOOGLE_ID = "1234.apps.googleusercontent.com";
    process.env.AUTH_GOOGLE_SECRET = "GOCSPX-shhh";
    expect(googleIsConfigured()).toBe(true);
  });

  it("is false with the id alone", () => {
    process.env.AUTH_GOOGLE_ID = "1234.apps.googleusercontent.com";
    expect(googleIsConfigured()).toBe(false);
  });

  it("is false with the secret alone", () => {
    process.env.AUTH_GOOGLE_SECRET = "GOCSPX-shhh";
    expect(googleIsConfigured()).toBe(false);
  });

  // The regression this file was written for: an existence check says yes to
  // both of these, and the button then fails on Google's side rather than
  // ours, where nobody can read the reason.
  it("is false when the id is present but blank", () => {
    process.env.AUTH_GOOGLE_ID = "";
    process.env.AUTH_GOOGLE_SECRET = "GOCSPX-shhh";
    expect(googleIsConfigured()).toBe(false);
  });

  it("is false when the id is whitespace only", () => {
    process.env.AUTH_GOOGLE_ID = "   ";
    process.env.AUTH_GOOGLE_SECRET = "GOCSPX-shhh";
    expect(googleIsConfigured()).toBe(false);
  });

  it("is false when the secret is present but blank", () => {
    process.env.AUTH_GOOGLE_ID = "1234.apps.googleusercontent.com";
    process.env.AUTH_GOOGLE_SECRET = "";
    expect(googleIsConfigured()).toBe(false);
  });
});

describe("emailIsConfigured", () => {
  it("is false without a Resend key", () => {
    expect(emailIsConfigured()).toBe(false);
  });

  it("is true with one", () => {
    process.env.RESEND_API_KEY = "re_shhh";
    expect(emailIsConfigured()).toBe(true);
  });

  // Stated as a test so the two gates cannot drift apart: whatever "set"
  // means for Google, it means the same for mail.
  it("is false when the key is present but blank", () => {
    process.env.RESEND_API_KEY = "";
    expect(emailIsConfigured()).toBe(false);
  });

  it("is false when the key is whitespace only", () => {
    process.env.RESEND_API_KEY = "   ";
    expect(emailIsConfigured()).toBe(false);
  });
});
