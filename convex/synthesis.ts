import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { annotationType, synthesisSectionKey } from "./schema";
import { getMembership, requireUserId } from "./lib/authz";
import { recordEvent } from "./lib/ledger";

/**
 * The post-meeting synthesis.
 *
 * A journal club's real output is what the room worked out, and it evaporates.
 * This turns the annotations the lab actually wrote during a session into a
 * structured write-up — and the whole design is about making that write-up
 * checkable rather than plausible.
 *
 * ## The constraint is the product
 *
 * The model is not asked what it thinks about the paper. It is given the
 * lab's annotations and told it may only quote or paraphrase-with-attribution
 * what is in front of it. Every item it emits carries the names it came from,
 * and an item that attributes to nobody the lab knows is dropped before it is
 * stored (see `sanitizeSections`). A synthesis that says something no member
 * said is a bug, not a flourish: the failure mode of a paper-summarizing
 * product is confident text nobody can trace, and that is exactly what a lab
 * cannot use.
 *
 * ## Privacy
 *
 * Only lab-visible annotations are loaded. Private annotations are never sent
 * anywhere, least of all to a model — the read is pinned to
 * `by_paper_and_visibility` at `"lab"` and session-scoped rows are re-checked
 * in memory.
 */

/* -------------------------------------------------------------------------
 * Shape
 * ---------------------------------------------------------------------- */

/**
 * The five sections, their headings, and what each one is for. The order here
 * is the order the write-up is stored and rendered in.
 */
const SECTIONS = [
  {
    key: "summary",
    heading: "What the discussion covered",
    brief:
      "The through-line of the discussion: what the lab actually spent its attention on, in 2-5 items.",
  },
  {
    key: "open-questions",
    heading: "Open questions",
    brief:
      "Questions the lab raised and did not settle. Prefer annotations typed 'open-question', but include unresolved questions raised in any note.",
  },
  {
    key: "critiques-and-methods",
    heading: "Critiques and methods",
    brief:
      "Objections to the paper's claims and observations about its methods, including any method a member noted as available or applicable.",
  },
  {
    key: "connections",
    heading: "Connections to the lab's work",
    brief:
      "Places where a member tied the paper to their own project or to other work the lab has read.",
  },
  {
    key: "next-reading",
    heading: "Decisions and next reading",
    brief:
      "Anything the lab decided to do, read, try, or follow up on. Omit items rather than invent them.",
  },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

const SECTION_KEYS = new Set<string>(SECTIONS.map((s) => s.key));

const HEADINGS: Readonly<Record<SectionKey, string>> = Object.fromEntries(
  SECTIONS.map((s) => [s.key, s.heading]),
) as Record<SectionKey, string>;

/** Default model. Overridable per deployment with `SYNTHESIS_MODEL`. */
const DEFAULT_MODEL = "claude-sonnet-5";

/** Enough for five sections of cited items and not much rope beyond that. */
const MAX_TOKENS = 4000;

const MAX_ANNOTATIONS = 400;

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

const synthesisSection = v.object({
  key: synthesisSectionKey,
  heading: v.string(),
  items: v.array(
    v.object({
      text: v.string(),
      attribution: v.array(v.string()),
    }),
  ),
});

const synthesisContext = v.object({
  labId: v.id("labs"),
  paperId: v.id("papers"),
  paperTitle: v.string(),
  paperAuthors: v.optional(v.array(v.string())),
  paperYear: v.optional(v.number()),
  sessionTitle: v.optional(v.string()),
  presenterName: v.string(),
  presenterNotes: v.optional(v.string()),
  memberNames: v.array(v.string()),
  annotations: v.array(
    v.object({
      _id: v.id("annotations"),
      parentId: v.optional(v.id("annotations")),
      author: v.string(),
      type: annotationType,
      pageIndex: v.number(),
      quote: v.string(),
      body: v.string(),
    }),
  ),
});

type SynthesisContext = {
  paperTitle: string;
  paperAuthors?: string[];
  paperYear?: number;
  sessionTitle?: string;
  presenterName: string;
  presenterNotes?: string;
  memberNames: string[];
  annotations: {
    _id: Id<"annotations">;
    parentId?: Id<"annotations">;
    author: string;
    type: Doc<"annotations">["type"];
    pageIndex: number;
    quote: string;
    body: string;
  }[];
};

/* -------------------------------------------------------------------------
 * Gating
 * ---------------------------------------------------------------------- */

/** Same words as `convex/sessions.ts` — a session id tells an outsider nothing. */
const NO_SUCH_SESSION = "That session is no longer on the calendar.";

/**
 * The presenter, whoever scheduled the session, or the PI — the same rule as
 * `canManage` in `convex/sessions.ts`.
 *
 * Duplicated rather than imported because that helper is module-private there
 * and exporting it would mean editing session code this PR has no other reason
 * to touch. Flagged as the one piece of logic in this file that has a twin.
 */
async function requireManageableSession(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"sessions">,
): Promise<{
  session: Doc<"sessions">;
  membership: Doc<"memberships">;
  userId: Id<"users">;
}> {
  const userId = await requireUserId(ctx);
  const session = await ctx.db.get(sessionId);
  const membership =
    session === null ? null : await getMembership(ctx, session.labId, userId);
  if (session === null || membership === null) {
    throw new ConvexError(NO_SUCH_SESSION);
  }
  const canManage =
    membership.role === "pi" ||
    session.presenterId === userId ||
    session.createdBy === userId;
  if (!canManage) {
    throw new ConvexError(
      "Only the presenter, whoever scheduled this session, or the lab's PI can synthesize it.",
    );
  }
  return { session, membership, userId };
}

/* -------------------------------------------------------------------------
 * Loading the material
 * ---------------------------------------------------------------------- */

/**
 * Everything the synthesis is allowed to be made of.
 *
 * Two reads because an annotation can reach a session two ways: written during
 * the meeting (`sessionId` set) or written on the paper at any point. Both are
 * the lab's thinking about this paper; the union is deduped by id.
 */
export const collectMaterial = internalQuery({
  args: { sessionId: v.id("sessions") },
  returns: synthesisContext,
  handler: async (ctx, args) => {
    const { session } = await requireManageableSession(ctx, args.sessionId);
    const paper = await ctx.db.get(session.paperId);
    if (paper === null) {
      throw new ConvexError(NO_SUCH_SESSION);
    }

    const onPaper = await ctx.db
      .query("annotations")
      .withIndex("by_paper_and_visibility", (q) =>
        q.eq("paperId", session.paperId).eq("visibility", "lab"),
      )
      .collect();
    const inSession = await ctx.db
      .query("annotations")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    const byId = new Map<Id<"annotations">, Doc<"annotations">>();
    for (const annotation of [...onPaper, ...inSession]) {
      // Belt and braces: the session index is not visibility-scoped, so the
      // check is repeated here. A private annotation must never reach a model.
      if (annotation.visibility !== "lab") continue;
      if (annotation.deletedAt !== undefined) continue;
      byId.set(annotation._id, annotation);
    }
    const ordered = [...byId.values()]
      .sort((a, b) => a._creationTime - b._creationTime)
      .slice(0, MAX_ANNOTATIONS);

    const names = new Map<Id<"users">, string>();
    const resolve = async (userId: Id<"users">): Promise<string> => {
      const cached = names.get(userId);
      if (cached !== undefined) return cached;
      const user = await ctx.db.get(userId);
      const name = user?.name ?? user?.email ?? "A lab member";
      names.set(userId, name);
      return name;
    };

    const annotations = [];
    for (const annotation of ordered) {
      annotations.push({
        _id: annotation._id,
        parentId: annotation.parentId,
        author: await resolve(annotation.memberId),
        type: annotation.type,
        pageIndex: annotation.anchor.pageIndex,
        quote: annotation.anchor.quote,
        body: annotation.body,
      });
    }

    return {
      labId: session.labId,
      paperId: session.paperId,
      paperTitle: paper.title,
      paperAuthors: paper.authors,
      paperYear: paper.year,
      sessionTitle: session.title,
      presenterName: await resolve(session.presenterId),
      presenterNotes: session.presenterNotes,
      memberNames: [...new Set(annotations.map((a) => a.author))],
      annotations,
    };
  },
});

/* -------------------------------------------------------------------------
 * The prompt
 * ---------------------------------------------------------------------- */

const SYSTEM_PROMPT = `You are writing up a lab's journal-club discussion from the annotations its members left on the paper.

Absolute constraints:
- You may ONLY use the annotations and presenter notes provided. They are the entire world.
- You may quote them or paraphrase them, but every item you write must be traceable to specific annotations, and every item must name the member or members it came from.
- Do NOT add facts about the paper, the field, or the method that no annotation states. Do not "fill in" what the lab probably meant.
- Do NOT evaluate the paper yourself. You are recording what the lab said, not joining the discussion.
- If a section has nothing behind it, return it with an empty item list. An empty section is correct; an invented one is not.
- Attribute with the exact member names as they appear in the material.

Write in plain, specific prose. Each item is one or two sentences. Prefer the member's own wording where it is sharp.

Respond with JSON only — no prose before or after, no markdown fences:
{"sections":[{"key":"<section key>","items":[{"text":"<the item>","attribution":["<member name>"]}]}]}`;

function typeLabel(type: Doc<"annotations">["type"]): string {
  return type.replace(/-/g, " ");
}

/** The material, laid out so a reference like `[A12]` is unambiguous. */
export function buildUserPrompt(context: SynthesisContext): string {
  const refs = new Map<Id<"annotations">, string>();
  context.annotations.forEach((a, index) => refs.set(a._id, `A${index + 1}`));

  const lines: string[] = [];
  const byline = [
    context.paperAuthors?.join(", "),
    context.paperYear === undefined ? undefined : String(context.paperYear),
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(", ");
  lines.push(`PAPER: ${context.paperTitle}${byline ? ` (${byline})` : ""}`);
  if (context.sessionTitle !== undefined) {
    lines.push(`SESSION: ${context.sessionTitle}`);
  }
  lines.push(`PRESENTER: ${context.presenterName}`);
  lines.push(
    `MEMBERS WHO ANNOTATED: ${
      context.memberNames.length > 0
        ? context.memberNames.join(", ")
        : "(none)"
    }`,
  );

  if (context.presenterNotes !== undefined) {
    lines.push("", "PRESENTER NOTES:", context.presenterNotes);
  }

  lines.push("", "ANNOTATIONS:");
  for (const annotation of context.annotations) {
    const ref = refs.get(annotation._id) ?? "A?";
    const parent =
      annotation.parentId === undefined
        ? undefined
        : refs.get(annotation.parentId);
    const head = [
      `[${ref}]`,
      annotation.author,
      `— ${typeLabel(annotation.type)}`,
      `— p. ${annotation.pageIndex + 1}`,
      parent === undefined ? undefined : `— reply to [${parent}]`,
    ]
      .filter((part): part is string => part !== undefined)
      .join(" ");
    lines.push(head);
    const quote = annotation.quote.trim().replace(/\s+/g, " ");
    if (quote.length > 0) {
      lines.push(`  on the passage: “${quote.slice(0, 300)}”`);
    }
    lines.push(`  wrote: ${annotation.body.trim()}`);
  }

  lines.push("", "SECTIONS TO PRODUCE, in this order:");
  for (const section of SECTIONS) {
    lines.push(`- "${section.key}" (${section.heading}): ${section.brief}`);
  }

  return lines.join("\n");
}

/* -------------------------------------------------------------------------
 * Parsing and sanitizing
 * ---------------------------------------------------------------------- */

type Section = {
  key: SectionKey;
  heading: string;
  items: { text: string; attribution: string[] }[];
};

/** The model was told to emit bare JSON; this survives it emitting a fence anyway. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new ConvexError(
      "The synthesis came back in a shape we couldn't read. Try again.",
    );
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new ConvexError(
      "The synthesis came back in a shape we couldn't read. Try again.",
    );
  }
}

/**
 * Turn whatever the model returned into the five sections, and enforce the
 * attribution rule mechanically.
 *
 * Names are matched against the members who actually annotated — exactly
 * first, then on a single name part, which is what catches "Ana" against "Ana
 * Ruiz". Unrecognized names are dropped, and an item left with no recognized
 * attribution is dropped with them. That is the whole guarantee: an item in a
 * stored synthesis is one that names at least one real member of this
 * discussion.
 */
export function sanitizeSections(
  parsed: unknown,
  memberNames: readonly string[],
): Section[] {
  const known = new Map<string, string>();
  for (const name of memberNames) {
    known.set(name.trim().toLowerCase(), name);
    const first = name.trim().split(/\s+/)[0];
    if (first !== undefined && first.length > 1) {
      const key = first.toLowerCase();
      if (!known.has(key)) known.set(key, name);
    }
  }

  const raw =
    typeof parsed === "object" && parsed !== null && "sections" in parsed
      ? (parsed as { sections: unknown }).sections
      : undefined;
  const rawSections = Array.isArray(raw) ? raw : [];

  const byKey = new Map<string, { text: string; attribution: string[] }[]>();
  for (const entry of rawSections) {
    if (typeof entry !== "object" || entry === null) continue;
    const { key, items } = entry as { key?: unknown; items?: unknown };
    if (typeof key !== "string" || !SECTION_KEYS.has(key)) continue;
    if (!Array.isArray(items)) continue;
    const cleaned: { text: string; attribution: string[] }[] = [];
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const { text, attribution } = item as {
        text?: unknown;
        attribution?: unknown;
      };
      if (typeof text !== "string" || text.trim().length === 0) continue;
      const names = Array.isArray(attribution) ? attribution : [];
      const resolved: string[] = [];
      for (const name of names) {
        if (typeof name !== "string") continue;
        const match = known.get(name.trim().toLowerCase());
        if (match !== undefined && !resolved.includes(match)) {
          resolved.push(match);
        }
      }
      if (resolved.length === 0) continue;
      cleaned.push({ text: text.trim(), attribution: resolved });
    }
    byKey.set(key, [...(byKey.get(key) ?? []), ...cleaned]);
  }

  return SECTIONS.map((section) => ({
    key: section.key,
    heading: HEADINGS[section.key],
    items: byKey.get(section.key) ?? [],
  }));
}

/* -------------------------------------------------------------------------
 * The call
 * ---------------------------------------------------------------------- */

type AnthropicResponse = {
  content?: { type?: string; text?: string }[];
  stop_reason?: string;
};

async function callAnthropic(
  model: string,
  apiKey: string,
  userPrompt: string,
): Promise<string> {
  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      // Off deliberately: thinking shares the output budget, and this task is
      // extraction under a constraint rather than reasoning. The budget should
      // all go to the write-up.
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    // The body can carry the API key's org details; it goes to the deployment
    // log, never to the caller.
    console.error(
      `Synthesis call failed: ${response.status} ${await response.text()}`,
    );
    throw new ConvexError(
      response.status === 429
        ? "The synthesis service is busy right now. Try again in a minute."
        : "The synthesis couldn't be generated right now. Try again.",
    );
  }

  const payload = (await response.json()) as AnthropicResponse;
  if (payload.stop_reason === "refusal") {
    throw new ConvexError(
      "The model declined to write this synthesis. Nothing has been saved.",
    );
  }
  const text = (payload.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  if (text.trim().length === 0) {
    throw new ConvexError(
      "The synthesis came back empty. Try again.",
    );
  }
  return text;
}

/**
 * Generate the write-up for an ended session.
 *
 * An action rather than a mutation because it makes a network call. The order
 * matters: gather → call → store, with the status transition inside the same
 * mutation as the write, so a failed or refused call leaves the session
 * exactly where it was.
 */
export const generate = action({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new ConvexError(
        "Synthesis isn't configured for this deployment yet.",
      );
    }
    const model = process.env.SYNTHESIS_MODEL ?? DEFAULT_MODEL;

    // Authorization lives in the query: `ctx.auth` carries through, so the
    // caller is checked against the session before anything is read.
    const context = await ctx.runQuery(internal.synthesis.collectMaterial, {
      sessionId: args.sessionId,
    });
    if (context.annotations.length === 0 && context.presenterNotes === undefined) {
      throw new ConvexError(
        "There's nothing to synthesize yet — no shared annotations and no presenter notes.",
      );
    }

    const text = await callAnthropic(model, apiKey, buildUserPrompt(context));
    const sections = sanitizeSections(
      extractJson(text),
      context.memberNames,
    );
    if (sections.every((section) => section.items.length === 0)) {
      throw new ConvexError(
        "The synthesis came back with nothing traceable to the lab's annotations. Nothing has been saved.",
      );
    }

    await ctx.runMutation(internal.synthesis.store, {
      sessionId: args.sessionId,
      model,
      sections,
    });
    return null;
  },
});

/**
 * Store the write-up and move the session to `synthesized`.
 *
 * Internal, but it re-runs the same gate the action did rather than trusting
 * an argument: an internal mutation is a function like any other, and the
 * cheapest way for authorization to stay true is for it never to be inherited.
 *
 * Re-generating replaces the row and leaves the status alone — the transition
 * is `ended → synthesized` and nothing else, so a second run on an already
 * synthesized session is a refresh, not a state change.
 */
export const store = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    model: v.string(),
    sections: v.array(synthesisSection),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { session, userId } = await requireManageableSession(
      ctx,
      args.sessionId,
    );
    if (session.status !== "ended" && session.status !== "synthesized") {
      throw new ConvexError(
        "A session can only be synthesized once it has ended.",
      );
    }

    const existing = await ctx.db
      .query("syntheses")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    const row = {
      sessionId: args.sessionId,
      labId: session.labId,
      sections: args.sections,
      model: args.model,
      generatedAt: Date.now(),
      generatedBy: userId,
    };
    if (existing === null) {
      await ctx.db.insert("syntheses", row);
    } else {
      await ctx.db.replace(existing._id, row);
    }

    if (session.status === "ended") {
      await ctx.db.patch(args.sessionId, { status: "synthesized" });
      await recordEvent(ctx, {
        labId: session.labId,
        actorId: userId,
        sessionId: args.sessionId,
        paperId: session.paperId,
        type: "session.synthesized",
      });
    }
    return null;
  },
});

/** The stored write-up for a session, for anyone in the lab. */
export const getForSession = query({
  args: { sessionId: v.id("sessions") },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("syntheses"),
      sessionId: v.id("sessions"),
      sections: v.array(synthesisSection),
      model: v.string(),
      generatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const session = await ctx.db.get(args.sessionId);
    const membership =
      session === null ? null : await getMembership(ctx, session.labId, userId);
    if (session === null || membership === null) {
      throw new ConvexError(NO_SUCH_SESSION);
    }
    const synthesis = await ctx.db
      .query("syntheses")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    if (synthesis === null) {
      return null;
    }
    return {
      _id: synthesis._id,
      sessionId: synthesis.sessionId,
      sections: synthesis.sections,
      model: synthesis.model,
      generatedAt: synthesis.generatedAt,
    };
  },
});
