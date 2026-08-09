import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ValidatorJSON } from "convex/values";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { normalizeWebhookUrl, slackIsConfigured } from "./lib/slack";
import {
  composeBoundaryMessage,
  composeBriefMessage,
  composeSynthesisMessage,
  slackDate,
  type SlackBlock,
  type SlackMessage,
} from "../lib/slack/compose";

/**
 * THE THIRD THING THAT LEAVES THE BUILDING.
 *
 * `convex/privacy.guard.test.ts` asserts the half of Margin's promise that
 * lives in the schema. `convex/email.guard.test.ts` asserts the half that
 * leaves in an envelope. This asserts the half that leaves through a webhook,
 * and it carries one promise the other two do not have to make.
 *
 * A Slack incoming-webhook URL is a **credential**. Anyone holding it can post
 * into the lab's channel as the lab, forever, with no further authentication —
 * there is no key rotation, no scope, and no way for Margin to tell a real post
 * from somebody else's. It is also, unlike an API key on a deployment, a
 * per-lab value that a *product surface* is responsible for. Which means the
 * one way it gets out is the ordinary one: somebody adds it to a query's
 * returns because the settings page would be easier to write with it there, and
 * it is then in a browser's query cache, in a React devtools pane, and in the
 * memory of every machine the PI has ever opened the lab on.
 *
 * So the promises, restated as assertions:
 *
 *   - No public function returns it, anywhere in the codebase. Checked by
 *     reading every public function's own returns validator out of Convex's
 *     introspection, not by grepping.
 *   - No table but `labs` holds it, and the append-only ledger never copies it.
 *   - One module posts to Slack, so there is one place these rules have to
 *     hold rather than four.
 *   - A composed message reaches for nothing remote, links only where it says
 *     it does, and sells nothing — the email constitution, in a channel.
 *   - A lab member's own words cannot become Slack markup on the way out.
 *
 * IF THIS FILE FAILS, YOU HAVE LEAKED A CREDENTIAL OR BROKEN A PRODUCT PROMISE.
 * The failure is the point. Do not relax an assertion to make it pass.
 */

/* -------------------------------------------------------------------------
 * Validator introspection — the same walk `privacy.guard.test.ts` does
 * ---------------------------------------------------------------------- */

type Json = unknown;

function isRecord(node: Json): node is Record<string, Json> {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

/** Every field declared anywhere under `node`, as `a.b.c` paths. */
function fieldPaths(node: Json, prefix: string[] = []): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((child) => fieldPaths(child, prefix));
  }
  if (!isRecord(node)) return [];

  if (node.type === "object" && isRecord(node.value)) {
    return Object.entries(node.value).flatMap(([name, entry]) => {
      const path = [...prefix, name];
      const nested = isRecord(entry) ? fieldPaths(entry.fieldType, path) : [];
      return [path.join("."), ...nested];
    });
  }

  return Object.entries(node)
    .filter(([key]) => key !== "type" && key !== "tableName")
    .flatMap(([, child]) => fieldPaths(child, prefix));
}

function wireForm(validator: unknown): ValidatorJSON {
  const json = (validator as { json?: unknown }).json;
  if (!isRecord(json)) {
    throw new Error(
      "Convex validator has no `.json` wire form; this guard cannot introspect the schema and must not be assumed to pass.",
    );
  }
  return json as ValidatorJSON;
}

/**
 * What a field name has to look like to be a webhook getting out.
 *
 * Matched on the field name rather than on its value, because a validator has
 * no values — and named broadly, because the leak this exists to catch is
 * somebody adding `slackUrl`, `webhook` or `deliveryUrl` to a returns shape
 * while thinking about a settings form rather than about a credential.
 */
const WEBHOOK_ISH = /webhook|hooks?slack|slack.*url|url.*slack/i;

const normalizeName = (name: string): string =>
  name.toLowerCase().replace(/[^a-z]/g, "");

/* -------------------------------------------------------------------------
 * 1. No public function hands the credential to a browser
 * ---------------------------------------------------------------------- */

/**
 * Every module under `convex/`, imported.
 *
 * Read off the directory rather than listed by hand, for the reason
 * `email.guard.test.ts` gives: a hard-coded list only constrains what is on it,
 * so the first leak in a module added next month — which is exactly the drift
 * this exists to catch — would sail past.
 */
const convexDir = fileURLToPath(new URL(".", import.meta.url));

const moduleNames = readdirSync(convexDir, { recursive: true })
  .map(String)
  .filter(
    (name) =>
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".fixtures.ts") &&
      !name.startsWith("_generated") &&
      name !== "schema.ts" &&
      name !== "auth.config.ts" &&
      name !== "tsconfig.json",
  )
  .sort();

const loaded = await Promise.all(
  moduleNames.map(async (name) => ({
    name,
    exports: (await import(
      /* @vite-ignore */ new URL(`./${name}`, import.meta.url).href
    )) as Record<string, unknown>,
  })),
);

/** One exported Convex function, with the bits this file needs. */
type Registered = {
  module: string;
  name: string;
  isPublic: boolean;
  kind: "query" | "mutation" | "action";
  returns: ValidatorJSON | null;
};

const registered: Registered[] = loaded.flatMap(({ name, exports }) =>
  Object.entries(exports).flatMap(([exported, value]) => {
    if (typeof value !== "function") return [];
    const fn = value as unknown as Record<string, unknown>;
    const kind =
      fn.isQuery === true
        ? "query"
        : fn.isMutation === true
          ? "mutation"
          : fn.isAction === true
            ? "action"
            : null;
    if (kind === null) return [];
    const exportReturns = fn.exportReturns;
    return [
      {
        module: name,
        name: `${name.replace(/\.ts$/, "")}.${exported}`,
        isPublic: fn.isPublic === true,
        kind,
        returns:
          typeof exportReturns === "function"
            ? (JSON.parse(
                (exportReturns as () => string)(),
              ) as ValidatorJSON)
            : null,
      } satisfies Registered,
    ];
  }),
);

const publicFunctions = registered.filter((fn) => fn.isPublic);

describe("the webhook URL never reaches a client", () => {
  it("found the functions it means to be checking", () => {
    // A walk that matched nothing would make every assertion below vacuous.
    expect(loaded.length).toBeGreaterThan(15);
    expect(moduleNames).toContain("slack.ts");
    expect(moduleNames).toContain("labs.ts");
    expect(publicFunctions.length).toBeGreaterThan(40);
    // And the introspection actually produced shapes, rather than nulls.
    const named = publicFunctions.map((fn) => fn.name);
    expect(named).toContain("slack.status");
    expect(named).toContain("labs.getLab");

    // Every public function Margin declares says what it returns, so the walk
    // below has a shape to walk. The three exceptions are not Margin's: they
    // are what `convexAuth()` registers on our behalf, and the library does
    // not declare a returns validator for them. Named rather than tolerated by
    // a fuzzy count, so a *fourth* undeclared function — which would be a
    // Margin function the leak check silently could not see into — fails here.
    const undeclared = publicFunctions
      .filter((fn) => fn.returns === null)
      .map((fn) => fn.name)
      .sort();
    expect(undeclared).toEqual([
      "auth.isAuthenticated",
      "auth.signIn",
      "auth.signOut",
    ]);
  });

  it("declares no webhook-shaped field in any public returns validator", () => {
    const offenders = publicFunctions.flatMap((fn) =>
      fieldPaths(fn.returns)
        .filter((path) => WEBHOOK_ISH.test(path.split(".").at(-1) ?? path))
        .map((path) => `${fn.name} → ${path}`),
    );

    expect(
      offenders,
      "A Slack webhook URL is a credential. It has no business in a query result, a browser cache, or a devtools pane — not even the PI's, who already has it in Slack.",
    ).toEqual([]);
  });

  it("does put it in the internal queries that need it, so the check is real", () => {
    // The inverse assertion. If the walk could not see a webhook field at all,
    // the one above would pass for the wrong reason forever.
    const internalWithWebhook = registered
      .filter(
        (fn) =>
          !fn.isPublic &&
          fieldPaths(fn.returns).some((path) => WEBHOOK_ISH.test(path)),
      )
      .map((fn) => fn.name)
      .sort();

    expect(internalWithWebhook).toEqual([
      "slack.boundaryPayload",
      "slack.briefPayload",
      "slack.synthesisPayload",
    ]);
  });

  it("tells every member whether their lab posts, without telling them where", () => {
    // The product half of the same rule: `connected` is a fact a member is
    // owed — their writing may be read by a channel — and the URL is not.
    const status = publicFunctions.find((fn) => fn.name === "slack.status");
    expect(fieldPaths(status?.returns).sort()).toEqual([
      "canManage",
      "connected",
    ]);
  });
});

/* -------------------------------------------------------------------------
 * 2. And no table but `labs` holds it
 * ---------------------------------------------------------------------- */

describe("where the credential is stored", () => {
  const tables = Object.entries(schema.tables).map(
    ([name, table]) => [name, wireForm(table.validator)] as const,
  );

  it("lives on labs, and only on labs", () => {
    const holders = tables.flatMap(([table, validator]) =>
      fieldPaths(validator).some((path) =>
        WEBHOOK_ISH.test(path.split(".").at(-1) ?? path),
      )
        ? [table]
        : [],
    );
    // Anchored in both directions: it is here, and it is nowhere else. A
    // second copy on `sessions` or `memberships` would be a second lifetime to
    // reason about and a second read path to forget to gate.
    expect(holders).toEqual(["labs"]);
    expect(fieldPaths(wireForm(schema.tables.labs.validator))).toContain(
      "slackWebhookUrl",
    );
  });

  it("is never copied into the append-only ledger", () => {
    // `events` rows are never updated and never deleted, so a credential in
    // one would outlive every disconnection — including the one a lab performs
    // *because* the credential leaked.
    const events = wireForm(schema.tables.events.validator);
    const offenders = fieldPaths(events).filter((path) =>
      WEBHOOK_ISH.test(path.split(".").at(-1) ?? path),
    );
    expect(offenders).toEqual([]);
    // And prove the ledger does record the fact itself, so members can see in
    // the record when their margin started leaving the building.
    expect(fieldPaths(events)).toContain("connected");
  });

  it("records the switch without describing it as reading", () => {
    // The privacy constitution's own vocabulary check, applied to the variant
    // this branch adds: nothing here may be spelled as a view or a read.
    const names = Object.keys(schema.tables).map(normalizeName);
    expect(names).toContain("labs");
    expect(names.some((name) => name.includes("slack"))).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * 3. One module posts to Slack
 * ---------------------------------------------------------------------- */

describe("the modules that post to Slack", () => {
  const sources = moduleNames.map((name) => ({
    name,
    // Comments are stripped so the prose explaining a rule cannot break it.
    code: readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, ""),
  }));

  it("found the sources it means to be checking", () => {
    expect(sources.length).toBeGreaterThan(15);
    expect(sources.find((s) => s.name === "slack.ts")?.code ?? "").toContain(
      "postToSlack",
    );
  });

  it("names Slack's host in exactly two places, and means both", () => {
    const naming = sources
      .flatMap(({ name, code }) => (code.includes("hooks.slack.com") ? [name] : []))
      .sort();
    // `lib/slack.ts` decides what a valid destination is; `slack.ts` says so to
    // the PI in the refusal copy when a paste is wrong. Nothing else has any
    // business knowing the host, and a third file naming it is a second
    // validator or a second transport.
    expect(naming).toEqual(["lib/slack.ts", "slack.ts"]);
  });

  it("routes every post through the one transport", () => {
    // A `fetch` to a lab-supplied URL belongs in exactly one function. A second
    // one would be a second place for the retry rule, the logging rule and the
    // "never put the URL in an error" rule to not hold.
    const posting = sources
      .flatMap(({ name, code }) =>
        code.includes("postToSlack(") ? [name] : [],
      )
      .sort();
    expect(posting).toEqual(["slack.ts"]);
  });

  it("keeps the credential out of anything that gets logged", () => {
    // Slack's refusal body is genuinely the most useful thing in a log and
    // carries no secret; the URL does. Nothing in the module interpolates it
    // into a `console` call.
    const slack = sources.find((source) => source.name === "slack.ts");
    const logged = [
      ...(slack?.code.matchAll(/console\.(?:error|warn|log)\(([\s\S]*?)\);/g) ??
        []),
    ].map((match) => match[1] ?? "");
    expect(logged.length).toBeGreaterThan(0);
    for (const call of logged) {
      expect(call).not.toMatch(/webhookUrl/i);
    }
  });
});

/* -------------------------------------------------------------------------
 * 4. What a composed message may contain
 * ---------------------------------------------------------------------- */

const SITE = "https://margin.example.edu";
const SESSION_URL = `${SITE}/app/sessions/s1`;
const PAPER_URL = `${SITE}/app/library/p1/read`;

/**
 * A note whose author is trying to get something into the lab's channel.
 *
 * Every one of these strings is something a member can type into an annotation
 * and get carried, verbatim, into a brief line or a write-up — which is the
 * whole reason the composers escape rather than trust.
 */
const HOSTILE =
  "<https://evil.example|click here> & <!channel> <@U024BE7LH> ```rm -rf```";

const composed: { name: string; message: SlackMessage; url: string }[] = [
  {
    name: "brief",
    message: composeBriefMessage({
      paperTitle: `Attention & Ablation <all of it>`,
      when: slackDate(Date.UTC(2026, 7, 13, 16, 0, 0)),
      presenterName: "Ada <Lovelace>",
      approvedByName: "Ada & Grace",
      citationCount: 12,
      sections: [
        { heading: "Open questions", items: [HOSTILE], droppedCount: 0 },
      ],
      url: SESSION_URL,
    }),
    url: SESSION_URL,
  },
  {
    name: "boundary post",
    message: composeBoundaryMessage({
      paperTitle: "Attention & Ablation",
      when: slackDate(Date.UTC(2026, 7, 13, 16, 0, 0)),
      presenterName: "Ada <Lovelace>",
      lines: [HOSTILE],
      annotationCount: 41,
      url: PAPER_URL,
    }),
    url: PAPER_URL,
  },
  {
    name: "write-up",
    message: composeSynthesisMessage({
      paperTitle: "Attention & Ablation",
      when: slackDate(Date.UTC(2026, 7, 13, 16, 0, 0)),
      approvedByName: "Ada & Grace",
      markdown: `## What we settled\n\n- ${HOSTILE}`,
      citationCount: 18,
      revised: false,
      url: SESSION_URL,
    }),
    url: SESSION_URL,
  },
];

function textOf(block: SlackBlock): string {
  if (block.type === "divider") return "";
  if (block.type === "context") {
    return block.elements.map((element) => element.text).join("\n");
  }
  return block.text.text;
}

const wire = (message: SlackMessage): string => JSON.stringify(message);

describe("no message reaches for anything remote", () => {
  it.each(composed)("$name carries no image of any kind", ({ message }) => {
    // The email constitution's first rule, in a channel. A tracking pixel is
    // an `image` block, and so is a wordmark — the second is how the first
    // arrives, because a CDN's access log is an open-rate report nobody asked
    // for. Slack renders an `image_url` by fetching it *from the reader's
    // client*, which makes it exactly the beacon email has.
    const serialized = wire(message);
    expect(serialized).not.toMatch(/image_url/i);
    expect(serialized).not.toMatch(/icon_url/i);
    expect(serialized).not.toMatch(/"type"\s*:\s*"image"/i);
    expect(serialized).not.toMatch(/accessory/i);
    expect(serialized).not.toMatch(/thumb_url/i);
    expect(serialized).not.toMatch(/attachments/i);
  });

  it.each(composed)("$name links only where it says it does", ({
    message,
    url,
  }) => {
    // Every link in the document, in Slack's one link syntax. Exactly the one
    // the reader was offered — no second origin, and in particular nothing on
    // a redirector's domain with the real destination in a query string.
    const links = [
      ...wire(message).matchAll(/<(https?:\\?\/\\?\/[^|>]+)\|/g),
    ].map((match) => (match[1] ?? "").replace(/\\\//g, "/"));
    expect(new Set(links)).toEqual(new Set([url]));
  });

  it.each(composed)("$name quotes a member's URL without linking it", ({
    message,
  }) => {
    // The fixtures above all carry `HOSTILE`, so this is a property of the
    // composers rather than of the examples: a member's `<url|label>` arrives
    // as the characters they typed, and Slack renders it as text.
    const serialized = wire(message);
    expect(serialized).toContain("&lt;https://evil.example|click here&gt;");
    expect(serialized).not.toContain("<https://evil.example");
  });

  it.each(composed)("$name cannot be made to shout at a channel", ({
    message,
  }) => {
    // `<!channel>` and `<@U…>` are Slack's broadcast and mention commands, and
    // both are things a lab member can type into a note. Escaped, they are
    // words. Unescaped, one annotation could notify a whole workspace.
    const serialized = wire(message);
    expect(serialized).not.toContain("<!channel>");
    expect(serialized).not.toContain("<@U024BE7LH>");
    expect(serialized).toContain("&lt;!channel&gt;");
    // The one `<!…>` command in the document is the date Margin composed.
    const commands = [...serialized.matchAll(/<!([a-z]+)\^/g)].map(
      (match) => match[1],
    );
    expect(new Set(commands)).toEqual(new Set(["date"]));
  });
});

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

  it.each(composed)("$name says nothing about money", ({ message }) => {
    const prose = [message.text, ...message.blocks.map(textOf)].join("\n");
    const offenders = forbidden.filter((pattern) => pattern.test(prose));
    expect(offenders.map(String)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * 5. What counts as a destination
 * ---------------------------------------------------------------------- */

describe("normalizeWebhookUrl", () => {
  const REAL = "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXX";

  it("takes a real incoming webhook, unchanged", () => {
    // The path is Slack's opaque secret. Normalizing any part of it — a case
    // fold, a stripped trailing slash — hands back a URL that no longer works.
    expect(normalizeWebhookUrl(REAL)).toBe(REAL);
    expect(normalizeWebhookUrl(`  ${REAL}\n`)).toBe(REAL);
  });

  it("takes the other shapes Slack issues", () => {
    const workflow =
      "https://hooks.slack.com/workflows/T000/A000/1234567890/abcdef";
    expect(normalizeWebhookUrl(workflow)).toBe(workflow);
    const trigger = "https://hooks.slack.com/triggers/T000/1234/abcdef";
    expect(normalizeWebhookUrl(trigger)).toBe(trigger);
  });

  it("refuses a host that merely contains Slack's", () => {
    // The reason this parses rather than matching a prefix. Both of these pass
    // `startsWith`-style thinking and neither is Slack.
    expect(
      normalizeWebhookUrl("https://hooks.slack.com.evil.example/services/x"),
    ).toBeNull();
    expect(
      normalizeWebhookUrl("https://evil.example/#https://hooks.slack.com/x"),
    ).toBeNull();
    expect(
      normalizeWebhookUrl("https://evil.example/https://hooks.slack.com/x"),
    ).toBeNull();
  });

  it("refuses plaintext, which is the credential on the wire", () => {
    expect(
      normalizeWebhookUrl("http://hooks.slack.com/services/T0/B0/X"),
    ).toBeNull();
  });

  it("refuses credentials in the authority", () => {
    expect(
      normalizeWebhookUrl("https://user:pass@hooks.slack.com/services/T0/B0/X"),
    ).toBeNull();
  });

  it("refuses a bare origin, which is what a half-copied paste looks like", () => {
    // Refused now, in front of the person who pasted it, rather than at the
    // T−2h boundary in a log nobody is reading.
    expect(normalizeWebhookUrl("https://hooks.slack.com")).toBeNull();
    expect(normalizeWebhookUrl("https://hooks.slack.com/")).toBeNull();
    expect(normalizeWebhookUrl("https://hooks.slack.com///")).toBeNull();
  });

  it("refuses what is not a URL at all", () => {
    expect(normalizeWebhookUrl("")).toBeNull();
    expect(normalizeWebhookUrl("   ")).toBeNull();
    expect(normalizeWebhookUrl("hooks.slack.com/services/T0/B0/X")).toBeNull();
    expect(normalizeWebhookUrl("javascript:alert(1)")).toBeNull();
    expect(
      normalizeWebhookUrl("file:///etc/passwd#hooks.slack.com"),
    ).toBeNull();
  });
});

describe("slackIsConfigured", () => {
  it("reads presence of the field as the whole answer", () => {
    expect(slackIsConfigured({ slackWebhookUrl: "https://x" })).toBe(true);
    expect(slackIsConfigured({})).toBe(false);
    expect(slackIsConfigured(null)).toBe(false);
  });

  it("treats a blank string as absent", () => {
    // The same reasoning `emailIsConfigured` applies to a deployment variable
    // saved empty: a value that is present but blank is not a value.
    expect(slackIsConfigured({ slackWebhookUrl: "" })).toBe(false);
  });
});
