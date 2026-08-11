/**
 * Which theme the product is in, and how that is decided before first paint.
 *
 * `app/globals.css` already answers to a class on <html>: `.light` and `.dark`
 * force a `color-scheme`, and no class at all leaves `prefers-color-scheme` to
 * decide. So a preference is one string in storage and one class name, and
 * everything below it is CSS that already exists.
 *
 * Two choices worth stating, because the obvious alternatives are both wrong
 * here:
 *
 * Storage is `localStorage`, not a cookie. A cookie would have to be read in
 * the root layout, and reading the request in the root layout opts the whole
 * tree out of static rendering — including `(marketing)`, which is prerendered
 * at build time on purpose (see the note on `RootLayout`).
 *
 * The class is applied by a blocking script, not by an effect. An effect runs
 * after the first paint, so a dark-preferring reader would see one frame of
 * sand before it corrected itself. That flash is the entire reason this file
 * is a string of JavaScript rather than a hook.
 */
export type ThemePreference = "auto" | "light" | "dark";

/**
 * Absent or unreadable storage means dark — the register the product is
 * written in, and the one the README has always claimed. Following the system
 * by default is what made a light-appearance laptop show a light Margin.
 */
export const DEFAULT_THEME: ThemePreference = "dark";

export const THEME_STORAGE_KEY = "margin-theme";

const PREFERENCES: readonly string[] = ["auto", "light", "dark"];

/**
 * A stored string, read as a preference. Anything that is not one of the three
 * — absent, truncated, left by an older build — resolves to the default rather
 * than raising: a corrupt entry should cost the reader a theme they can change
 * back, not a page that will not render.
 */
export function readPreference(raw: string | null): ThemePreference {
  return raw !== null && PREFERENCES.includes(raw)
    ? (raw as ThemePreference)
    : DEFAULT_THEME;
}

/**
 * The class <html> should wear. `auto` wears none: the media query in
 * `globals.css` is what follows the system, it follows it live, and so there
 * is nothing to listen to and nothing to re-apply when the machine flips at
 * dusk.
 */
export function themeClass(
  preference: ThemePreference,
): "light" | "dark" | null {
  return preference === "auto" ? null : preference;
}

/**
 * The script that runs before the first paint.
 *
 * Assembled from the constants above rather than written out, so a renamed key
 * or a changed default cannot leave the script saying one thing and the module
 * another — the class of bug that would only show as a flash on a stranger's
 * machine.
 *
 * Synchronous and inlined in <head>: it blocks parsing for the microsecond it
 * takes to read one storage key, which is the price of not painting the wrong
 * page. The catch falls back to the default class rather than doing nothing,
 * because storage being unavailable is not the reader asking to follow their
 * system.
 */
export const THEME_BOOT_SCRIPT = [
  "(function(){",
  `var d=${JSON.stringify(themeClass(DEFAULT_THEME) ?? "")};`,
  "var l=document.documentElement.classList;",
  "try{",
  `var p=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});`,
  'var c=p==="light"||p==="dark"?p:p==="auto"?"":d;',
  // Remove before add, even though the server renders <html> classless: the
  // script asserts the whole theme state instead of trusting a clean start,
  // so running it against a document that already wears a class — a future
  // second inclusion, a template that gained a default — converges rather
  // than stacking `light` beside `dark`.
  'l.remove("light","dark");',
  "if(c)l.add(c);",
  '}catch(e){l.remove("light","dark");if(d)l.add(d)}',
  "})()",
].join("");
