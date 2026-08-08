import { describe, expect, it } from "vitest";
import { describePdfOpenError } from "./extract";

/**
 * pdf.js's exceptions are not `Error` subclasses in any way `instanceof` can
 * see — `BaseException` sets `name` by hand and hangs a plain `Error` off the
 * prototype — and they cross a worker boundary before we get them. These
 * stand-ins are shaped the way a real one arrives.
 */
function pdfjsException(name: string, message: string): unknown {
  return { name, message };
}

describe("describePdfOpenError", () => {
  it("names a password-protected PDF and says how to get past it", () => {
    const described = describePdfOpenError(
      pdfjsException("PasswordException", "No password given"),
    );
    expect(described).toContain("password-protected");
    expect(described).toContain("Open it with the password");
  });

  it("names a file that isn't a readable PDF", () => {
    const described = describePdfOpenError(
      pdfjsException("InvalidPDFException", "Invalid PDF structure."),
    );
    expect(described).toContain("damaged");
    expect(described).toContain("re-download");
  });

  it("declines the failures it has nothing specific to say about", () => {
    expect(
      describePdfOpenError(
        pdfjsException("UnknownErrorException", "Worker was destroyed"),
      ),
    ).toBeUndefined();
    expect(describePdfOpenError(new Error("network"))).toBeUndefined();
  });

  it("survives a thrown value that is not an object at all", () => {
    expect(describePdfOpenError(undefined)).toBeUndefined();
    expect(describePdfOpenError(null)).toBeUndefined();
    expect(describePdfOpenError("PasswordException")).toBeUndefined();
    expect(describePdfOpenError({})).toBeUndefined();
  });

  it("leaves no exclamation marks in front of a member", () => {
    for (const name of ["PasswordException", "InvalidPDFException"]) {
      expect(describePdfOpenError(pdfjsException(name, ""))).not.toContain("!");
    }
  });
});
