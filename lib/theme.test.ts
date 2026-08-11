import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  readPreference,
  themeClass,
} from "./theme";

/**
 * The boot script is the only code in the product that runs before React, so
 * it is the only code that cannot be checked by rendering something. It is a
 * string, though, and a string is testable: run it against a stand-in document
 * and a stand-in storage, then read back what it put on the class list.
 *
 * `new Function` rather than `eval` so the script cannot reach this file's
 * scope by accident. It gets exactly the two globals it is allowed to see,
 * which doubles as an assertion that it does not quietly need a third.
 */
function boot(stored: string | null | (() => never)): string[] {
  const classes: string[] = [];
  const documentStub = {
    documentElement: {
      classList: {
        add: (name: string) => {
          classes.push(name);
        },
      },
    },
  };
  const localStorageStub = {
    getItem: (key: string) => {
      if (key !== THEME_STORAGE_KEY) {
        throw new Error(`the script read the wrong key: ${key}`);
      }
      return typeof stored === "function" ? stored() : stored;
    },
  };
  new Function("document", "localStorage", THEME_BOOT_SCRIPT)(
    documentStub,
    localStorageStub,
  );
  return classes;
}

describe("the boot script", () => {
  it("is dark on a first visit, whatever the system asks for", () => {
    expect(boot(null)).toEqual(["dark"]);
  });

  it("honours a stored light", () => {
    expect(boot("light")).toEqual(["light"]);
  });

  it("honours a stored dark", () => {
    expect(boot("dark")).toEqual(["dark"]);
  });

  it("sets no class for auto, leaving the media query to decide", () => {
    // Not a matchMedia read: `:root:not(.light)` under `prefers-color-scheme`
    // already follows the system live, so "auto" is the absence of an opinion
    // rather than a snapshot of one — and it keeps following after dusk with
    // nothing listening.
    expect(boot("auto")).toEqual([]);
  });

  it("falls back to the default on an entry it does not recognise", () => {
    expect(boot("midnight")).toEqual([DEFAULT_THEME]);
  });

  it("still themes the page when storage throws outright", () => {
    // `localStorage` throws, not returns null, in a partitioned iframe or with
    // site data blocked. A theme is never worth a blank page.
    expect(
      boot(() => {
        throw new Error("site data blocked");
      }),
    ).toEqual([DEFAULT_THEME]);
  });

  it("cannot drift from the module's own key", () => {
    expect(THEME_BOOT_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });
});

describe("readPreference", () => {
  it("passes the three real answers through", () => {
    expect(readPreference("auto")).toBe("auto");
    expect(readPreference("light")).toBe("light");
    expect(readPreference("dark")).toBe("dark");
  });

  it("treats absent and corrupt the same way", () => {
    expect(readPreference(null)).toBe(DEFAULT_THEME);
    expect(readPreference("")).toBe(DEFAULT_THEME);
    expect(readPreference("Dark")).toBe(DEFAULT_THEME);
  });
});

describe("themeClass", () => {
  it("names the class for a forced theme and nothing for auto", () => {
    expect(themeClass("light")).toBe("light");
    expect(themeClass("dark")).toBe("dark");
    expect(themeClass("auto")).toBeNull();
  });
});
