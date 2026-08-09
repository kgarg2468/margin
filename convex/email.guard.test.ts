import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composeSignInEmail, renderEmail, siteUrl } from "./auth";
import { composeInviteEmail } from "./invites";
import { composeNotificationEmail } from "./notifications";

/**
 * THE EMAIL CONSTITUTION, MECHANICALLY.
 *
 * `convex/privacy.guard.test.ts` asserts the half of Margin's promise that
 * lives in the schema: no table, no field and no ledger event records that
 * somebody looked at something. This file asserts the half that leaves the
 * building.
 *
 * An email is the one artefact Margin hands to a third party and cannot take
 * back, and the industry default for it is surveillance: a one-pixel image
 * that reports the open, an `href` rewritten to a redirector that reports the
 * press, a webfont from a CDN that reports both by accident. Every one of
 * those is a line of code away, none of them is visible in a rendered
 * message, and a product whose sign-in page says "Margin never tracks what you
 * read" cannot ship any of them.
 *
 * So the promises, restated as assertions:
 *
 *   - Every message is one document with no remote reference of any kind. No
 *     `<img>`, no `background-image`, no `url(...)`, no `http` outside the one
 *     link the reader was told about.
 *   - Every message renders through `renderEmail`, so there is one place these
 *     rules have to hold rather than three.
 *   - Both parts of every message say the same thing, and the plain part
 *     carries the link — a client that shows text is not shown a dead end.
 *   - Nothing anywhere sells anything.
 *
 * IF THIS FILE FAILS, YOU HAVE BROKEN A MARKETING-LEVEL PRODUCT PROMISE.
 * The failure is the point. Do not relax an assertion to make it pass.
 *
 * What it cannot see: Resend applies open tracking and click tracking *after*
 * this code is done, as per-domain switches in their dashboard. Both must be
 * off, and only an operator can confirm that — see the header of
 * `convex/auth.ts`.
 */

const SITE = "https://margin.example.edu";

/**
 * A title at exactly the cap `convex/papers.ts` enforces.
 *
 * Fixtures that are all short and all polite test the fixtures, not the code.
 * A real library holds preprints whose titles run to a paragraph, and
 * `cleanTitle` admits 500 characters of one — so this is what the subject-line
 * bound below is actually up against.
 */
const LONG_TITLE =
  `On the Reproducibility of Attention Mechanisms Under Ablation: ${"a subtitle of the sort a preprint genuinely carries, ".repeat(10)}`.slice(
    0,
    500,
  );

type Message = {
  name: string;
  subject: string;
  text: string;
  html: string;
  /** The one link the message offers, and the only URL it may contain. */
  url: string;
};

/** One of each. Every message Margin is capable of sending is in this list. */
const messages: Message[] = [
  {
    name: "sign-in link",
    ...composeSignInEmail(`${SITE}/api/auth/verify?token=abc123`),
    url: `${SITE}/api/auth/verify?token=abc123`,
  },
  {
    name: "invitation",
    ...composeInviteEmail({
      inviter: "Ada Lovelace",
      labName: "Babbage Lab",
      code: "K7QX2M9P",
      expires: "2026-09-01",
      url: `${SITE}/app?invite=K7QX2M9P`,
    }),
    url: `${SITE}/app?invite=K7QX2M9P`,
  },
  {
    name: "mention",
    ...composeNotificationEmail({
      kind: "mention",
      actorName: "Ada Lovelace",
      paperTitle: "Attention Is All You Need",
      snippet: "Is this the same ablation as figure 3?",
      url: `${SITE}/app/library/p1/read`,
    }),
    url: `${SITE}/app/library/p1/read`,
  },
  {
    name: "reply",
    ...composeNotificationEmail({
      kind: "reply",
      actorName: "Ada Lovelace",
      paperTitle: "Attention Is All You Need",
      snippet: "Not quite — theirs holds the head count fixed.",
      url: `${SITE}/app/library/p1/read`,
    }),
    url: `${SITE}/app/library/p1/read`,
  },
  {
    name: "mention of a paper with a 500-character title",
    ...composeNotificationEmail({
      kind: "mention",
      actorName: "Ada Lovelace",
      paperTitle: LONG_TITLE,
      snippet: "Is this the same ablation as figure 3?",
      url: `${SITE}/app/library/p2/read`,
    }),
    url: `${SITE}/app/library/p2/read`,
  },
];

// --- 1. Nothing that phones home ------------------------------------------

describe("no message reaches for anything remote", () => {
  it.each(messages)("$name loads no external resource", (message) => {
    // A tracking pixel is an `<img>`, and so is a logo, and the second is how
    // the first arrives: somebody adds a wordmark from a CDN and the CDN's
    // access log becomes an open-rate report nobody asked for.
    expect(message.html).not.toMatch(/<img/i);
    expect(message.html).not.toMatch(/background-image/i);
    expect(message.html).not.toMatch(/url\(/i);
    expect(message.html).not.toMatch(/<link/i);
    expect(message.html).not.toMatch(/@import/i);
    expect(message.html).not.toMatch(/<script/i);
  });

  it.each(messages)("$name links only where it says it does", (message) => {
    const urls = [...message.html.matchAll(/https?:\/\/[^"'\s<>]+/gi)].map(
      (match) => match[0],
    );
    // Exactly the link the reader was offered — no second origin, and in
    // particular nothing on a redirector's domain with the real destination
    // folded into a query string.
    expect(new Set(urls)).toEqual(new Set([message.url]));
  });

  it("quotes a note that contains a URL without linking it", () => {
    // Every fixture above is benign, which makes the assertion above a
    // property of the templates rather than of shipped output: a lab member
    // can type whatever they like into a note, and the note becomes a snippet
    // in somebody's inbox. This is what happens then, stated on purpose
    // rather than left to be discovered.
    //
    // The member's words are quoted faithfully and escaped, so the URL is
    // text. A mail client may auto-link text — that is the client's doing,
    // not a redirector Margin inserted — but the one `href` in the document
    // is still the one the reader was offered, and the markup they typed is
    // not markup by the time it arrives.
    const hostile = composeNotificationEmail({
      kind: "mention",
      actorName: "Ada Lovelace",
      paperTitle: "Attention Is All You Need",
      snippet: `See <a href="http://evil.example/x">this</a> — http://evil.example/x`,
      url: `${SITE}/app/library/p1/read`,
    });

    const hrefs = [...hostile.html.matchAll(/href="([^"]*)"/g)].map(
      (match) => match[1],
    );
    expect(hrefs).toEqual([`${SITE}/app/library/p1/read`]);
    // One anchor in the document, and it is the button — the one the member
    // typed did not survive as markup.
    expect([...hostile.html.matchAll(/<a[\s>]/gi)]).toHaveLength(1);
    expect(hostile.html).not.toMatch(/<a[^>]*evil\.example/i);
    expect(hostile.html).toContain("&lt;a href=&quot;http://evil.example/x");
    // Quoted, not censored: the snippet is what the person wrote.
    expect(hostile.text).toContain("http://evil.example/x");
  });
});

// --- 2. One renderer, so there is one place the rules can hold -------------

describe("every message goes through renderEmail", () => {
  const rendered = renderEmail({
    heading: "Heading",
    paragraphs: ["Body."],
    action: { label: "Do the thing", url: `${SITE}/somewhere` },
  });

  it("is a whole document with a declared charset", () => {
    // Not pedantry: every subject and snippet Margin sends carries “ ” and …,
    // and a fragment with no charset is decoded by whatever the client
    // guesses.
    expect(rendered).toMatch(/^<!doctype html>/i);
    expect(rendered).toMatch(/<meta charset="utf-8">/i);
    expect(rendered).toMatch(/<html lang="en">/i);
    expect(rendered).toContain("</html>");
  });

  it.each(messages)("$name is one of its documents", (message) => {
    expect(message.html).toMatch(/^<!doctype html>/i);
    expect(message.html).toContain("</html>");
    // The letterhead, lowercase, the way the product spells itself.
    expect(message.html).toContain(">margin</p>");
  });

  it("escapes what it is given rather than trusting it", () => {
    const hostile = renderEmail({
      heading: `<script>alert("x")</script>`,
      paragraphs: [`Ada & "Grace" <b>`],
      action: { label: "Open", url: `${SITE}/a?b=1&c="2"` },
      footnotes: [`<img src=x onerror=y>`],
    });
    expect(hostile).not.toContain("<script>alert");
    expect(hostile).not.toContain("<b>");
    expect(hostile).not.toMatch(/<img/i);
    expect(hostile).toContain("&amp;");
    expect(hostile).toContain("&lt;");
    expect(hostile).toContain("&quot;");
  });
});

// --- 3. The plain part is a whole message, not a stub ----------------------

describe("both parts of every message", () => {
  it.each(messages)("$name carries its link in the text part", (message) => {
    expect(message.text).toContain(message.url);
    expect(message.text.trim().length).toBeGreaterThan(40);
  });

  it.each(messages)("$name has a subject that says who and what", (message) => {
    expect(message.subject.trim().length).toBeGreaterThan(0);
    // A subject line that wraps in an inbox list is a subject line nobody
    // finishes reading.
    expect(message.subject.length).toBeLessThan(120);
    expect(message.subject).not.toContain("undefined");
    expect(message.subject).not.toMatch(/\bnull\b/);
  });

  it("names the actor and the paper in a notification", () => {
    const mention = messages.find((m) => m.name === "mention");
    const reply = messages.find((m) => m.name === "reply");
    expect(mention?.subject).toBe(
      "Ada Lovelace mentioned you on “Attention Is All You Need”",
    );
    expect(reply?.subject).toBe(
      "Ada Lovelace replied to your note on “Attention Is All You Need”",
    );
    // The two kinds are different news and must not collapse into one line.
    expect(mention?.subject).not.toBe(reply?.subject);
  });

  it("shortens a paper title rather than posting all 500 characters of it", () => {
    // The bound above is only a real bound if the composer enforces it. A
    // 500-character title — which `convex/papers.ts` accepts — would otherwise
    // become a ~540-character subject line that every client truncates
    // somewhere different.
    const long = messages.find((m) => m.name.includes("500-character"));
    expect(long?.subject).toContain("…”");
    expect(long?.subject).toContain("On the Reproducibility of Attention");
    expect(long?.subject).not.toContain(LONG_TITLE);
    // Both halves say the same thing, so the opening is shortened too.
    expect(long?.text).not.toContain(LONG_TITLE);
    expect(long?.html).not.toContain(LONG_TITLE);
  });

  it("tells a notification's recipient why they were written to", () => {
    // In both parts. The plain-text reader is owed the same explanation, and
    // it is the sentence that stops a mention reading like a mailing list.
    const mention = messages.find((m) => m.name === "mention");
    const because =
      "You're getting this because you're in this lab and this note was addressed to you.";
    expect(mention?.text).toContain(because);
    expect(mention?.html).toContain(because);
  });
});

// --- 4. Nothing sells anything --------------------------------------------

describe("no message monetizes", () => {
  const forbidden = [
    /\bupgrade\b/i,
    /\bpricing\b/i,
    /\bfree trial\b/i,
    /\bsubscription\b/i,
    /\bbilling\b/i,
    /\bper seat\b/i,
    /\bper user\/month\b/i,
  ];

  it.each(messages)("$name says nothing about money", (message) => {
    // The HTML part too. Prose that exists only in the styled half is prose
    // most recipients read and this scan used not to see at all.
    const prose = `${message.subject}\n${message.text}\n${message.html}`;
    const offenders = forbidden.filter((pattern) => pattern.test(prose));
    expect(offenders.map(String)).toEqual([]);
  });
});

// --- 5. A link is absolute or there is no link -----------------------------

describe("siteUrl", () => {
  function withSiteUrl<T>(value: string | undefined, run: () => T): T {
    const before = process.env.SITE_URL;
    if (value === undefined) {
      delete process.env.SITE_URL;
    } else {
      process.env.SITE_URL = value;
    }
    try {
      return run();
    } finally {
      if (before === undefined) {
        delete process.env.SITE_URL;
      } else {
        process.env.SITE_URL = before;
      }
    }
  }

  it("answers null rather than an empty prefix when unset", () => {
    // The bug this replaced: `(process.env.SITE_URL ?? "")` sent real mail
    // whose only link was `/app/library/…`, which is nowhere from an inbox.
    expect(withSiteUrl(undefined, siteUrl)).toBeNull();
    expect(withSiteUrl("", siteUrl)).toBeNull();
    expect(withSiteUrl("   ", siteUrl)).toBeNull();
  });

  it("refuses an origin with no scheme", () => {
    expect(withSiteUrl("margin.example.edu", siteUrl)).toBeNull();
    expect(withSiteUrl("/app", siteUrl)).toBeNull();
  });

  it("refuses anything that is not a bare origin", () => {
    // Every link is built by concatenation — `${site}/app?invite=…` — so a
    // query on the base becomes a path on a query string, which is nowhere.
    expect(
      withSiteUrl("https://margin.example.edu?source=mail", siteUrl),
    ).toBeNull();
    expect(withSiteUrl("https://margin.example.edu#top", siteUrl)).toBeNull();
    expect(
      withSiteUrl("https://margin.example.edu/margin", siteUrl),
    ).toBeNull();
    // And credentials in the authority would be mailed to every invitee.
    expect(
      withSiteUrl("https://admin:hunter2@margin.example.edu", siteUrl),
    ).toBeNull();
    // Absolute, but not a scheme a browser will follow from an inbox.
    expect(withSiteUrl("ftp://margin.example.edu", siteUrl)).toBeNull();
    expect(
      withSiteUrl("javascript:alert(document.domain)", siteUrl),
    ).toBeNull();
  });

  it("takes an absolute origin and drops its trailing slashes", () => {
    expect(withSiteUrl("https://margin.example.edu", siteUrl)).toBe(
      "https://margin.example.edu",
    );
    expect(withSiteUrl("https://margin.example.edu///", siteUrl)).toBe(
      "https://margin.example.edu",
    );
    expect(withSiteUrl("  http://localhost:3000/  ", siteUrl)).toBe(
      "http://localhost:3000",
    );
  });
});

// --- 6. The rule holds in the source, not only in the output ---------------

describe("the modules that send mail", () => {
  // Read off the directory rather than listed by hand. A hard-coded list of
  // three filenames only constrains those three, so the first mail path added
  // in a fourth module — which is exactly the drift these assertions exist to
  // catch — would sail past untouched. Tests are skipped because they quote
  // the forbidden strings in order to forbid them; `_generated` is Convex's
  // output, not ours.
  const convexDir = fileURLToPath(new URL(".", import.meta.url));
  const sources = readdirSync(convexDir, { recursive: true })
    .map(String)
    .filter(
      (name) =>
        name.endsWith(".ts") &&
        !name.endsWith(".test.ts") &&
        !name.startsWith("_generated"),
    )
    .sort()
    .map((name) => ({
      name,
      text: readFileSync(
        fileURLToPath(new URL(`./${name}`, import.meta.url)),
        "utf8",
      ),
    }));

  it("found the modules it means to be checking", () => {
    // A glob that matched nothing would make every assertion below vacuous.
    expect(sources.length).toBeGreaterThan(3);
    const names = sources.map((source) => source.name);
    expect(names).toContain("auth.ts");
    expect(names).toContain("invites.ts");
    expect(names).toContain("notifications.ts");
  });

  it.each(sources)("$name composes no image tag", ({ text }) => {
    // Checked in the source as well as the output because a template added
    // tomorrow for an event that does not exist yet would not be in the list
    // above, and this is the assertion that would still catch it. Comments are
    // stripped first so the prose explaining the rule cannot break it.
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/<img/i);
    expect(code).not.toMatch(/background-image/i);
  });

  it("routes every send through the one transport", () => {
    // `fetch` to Resend belongs in exactly one function. A second one would be
    // a second place for these rules to not hold.
    const endpoints = sources.flatMap(({ name, text }) =>
      text.includes("api.resend.com") ? [name] : [],
    );
    expect(endpoints).toEqual(["auth.ts"]);
  });
});
