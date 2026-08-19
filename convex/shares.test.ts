import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "./_generated/dataModel";
import {
  FakeCtx,
  handlerOf,
  rowAt,
  seedAnnotation,
  seedLab,
} from "./delegations.fixtures";
import {
  REDACTED_NOTE_TEXT,
  forPaper,
  pdfForShare,
  revoke,
  setPaperOptIn,
  sharePaper,
  shareSynthesis,
  view,
} from "./shares";
import schema from "./schema";

vi.mock("@convex-dev/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/auth/server")>()),
  getAuthUserId: async (ctx: unknown) =>
    (ctx as { auth?: { userId?: string } }).auth?.userId ?? null,
}));

/**
 * THE PUBLIC SURFACE, MECHANICALLY.
 *
 * `convex/shares.ts` is the only query in this backend that answers somebody
 * who has not signed in. Everything else in the product is protected by a
 * membership check that fails closed; this one is protected by the rules in
 * this file and by nothing else.
 *
 * The four promises, from `docs/PLG.md` §5 and the privacy constitution:
 *
 *   1. **A private note can never reach a public page.** Not by a filter that
 *      was forgotten, not through a reply, not through a redaction marker that
 *      quotes it, and not in a field of the view model nobody renders.
 *   2. **Lab-visible is not public.** A note appears only if its author has
 *      separately opted this paper in. Another member's writing is not the
 *      sharer's to publish.
 *   3. **Revocation is on read, and it is total.** A taken-down link is
 *      indistinguishable from one that was never minted — the page, and the
 *      PDF behind it, both.
 *   4. **A write-up travels only while its signature holds.** No sign-off, or
 *      a note withdrawn since the sign-off, and the link deads.
 *
 * IF THIS FILE FAILS, A STRANGER CAN READ SOMETHING NOBODY PUBLISHED. Do not
 * relax an assertion to make it pass.
 */

/** The string that must never appear anywhere in a public answer. */
const SECRET = "ZZZ-PRIVATE-NOBODY-SHARED-THIS-ZZZ";

type Handler<A, R> = (ctx: FakeCtx, args: A) => Promise<R>;

/** `handlerOf`, with the argument and answer types the call site knows. */
function call<A, R>(registered: unknown): Handler<A, R> {
  return handlerOf(registered) as unknown as Handler<A, R>;
}

const publicView = call<
  { token: string },
  | null
  | {
      kind: "paper";
      labName: string;
      title: string;
      hasPdf: boolean;
      truncated: boolean;
      notes: {
        _id: Id<"annotations">;
        authorName: string;
        body: string;
        quote: string;
        redacted: boolean;
        status?: string;
        replies: { _id: Id<"annotations">; authorName: string; body: string }[];
      }[];
    }
  | {
      kind: "synthesis";
      labName: string;
      paperTitle: string;
      text: string;
      approvedAt: number;
    }
>(view);

const share = call<{ paperId: Id<"papers"> }, { token: string }>(sharePaper);
const shareWriteUp = call<{ sessionId: Id<"sessions"> }, { token: string }>(
  shareSynthesis,
);
const takeDown = call<{ shareId: Id<"shares"> }, null>(revoke);
const optIn = call<{ paperId: Id<"papers">; included: boolean }, null>(
  setPaperOptIn,
);
const panel = call<
  { paperId: Id<"papers"> },
  {
    share: { _id: Id<"shares">; token: string; canRevoke: boolean } | null;
    optedIn: boolean;
    optedInCount: number;
  }
>(forPaper);
const pdf = call<
  { token: string },
  { storageId: Id<"_storage">; title: string } | null
>(pdfForShare);

/** A lab, a paper, a session, and the PI signed in. */
async function setup() {
  const ctx = new FakeCtx();
  const seed = await seedLab(ctx);
  ctx.auth = { userId: seed.pi };
  await ctx.db.patch(seed.paperId, { storageId: "storage_seed" });
  return { ctx, ...seed };
}

function indexesOf(table: unknown): { indexDescriptor: string }[] {
  const indexes = (table as { indexes?: unknown }).indexes;
  if (!Array.isArray(indexes)) {
    throw new Error("a table definition no longer exposes `indexes`");
  }
  return indexes as { indexDescriptor: string }[];
}

function wireForm(validator: unknown): unknown {
  const json = (validator as { json?: unknown }).json;
  if (json === undefined) {
    throw new Error(
      "Convex validator has no `.json` wire form; this guard cannot introspect the schema and must not be assumed to pass.",
    );
  }
  return json;
}

function asPaper(answer: Awaited<ReturnType<typeof publicView>>) {
  if (answer === null || answer.kind !== "paper") {
    throw new Error(
      `expected a live paper share, got ${answer === null ? "null" : answer.kind}`,
    );
  }
  return answer;
}

/* -------------------------------------------------------------------------
 * 1. Private notes
 * ---------------------------------------------------------------------- */

describe("a private note never reaches a public page", () => {
  it("is absent from the view model, in every field of it", async () => {
    const { ctx, pi, labId, paperId } = await setup();
    await seedAnnotation(
      ctx,
      { labId, paperId, memberId: pi },
      { visibility: "private", body: SECRET },
    );
    const { token } = await share(ctx, { paperId });

    const answer = await publicView(ctx, { token });

    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  it("is never even read: the query goes through the visibility index", async () => {
    const { ctx, paperId } = await setup();
    const { token } = await share(ctx, { paperId });
    await publicView(ctx, { token });

    // The structural half of the promise. A filter applied after a read is a
    // filter somebody can delete; an index that was only ever asked for
    // lab-visible rows cannot hand back a private one at all.
    const read = ctx.db.lastReadOf("by_paper_and_visibility");
    expect(read?.table).toBe("annotations");
    expect(read?.constraints).toContainEqual({
      kind: "eq",
      field: "visibility",
      value: "lab",
    });
  });

  it("stays gone when its author takes a shared note private later", async () => {
    const { ctx, pi, labId, paperId } = await setup();
    const noteId = await seedAnnotation(
      ctx,
      { labId, paperId, memberId: pi },
      { body: SECRET },
    );
    const { token } = await share(ctx, { paperId });
    expect(JSON.stringify(await publicView(ctx, { token }))).toContain(SECRET);

    await ctx.db.patch(noteId, { visibility: "private" });

    expect(JSON.stringify(await publicView(ctx, { token }))).not.toContain(
      SECRET,
    );
  });
});

/* -------------------------------------------------------------------------
 * 2. Lab-visible is not public
 * ---------------------------------------------------------------------- */

describe("consent decomposes per author", () => {
  it("leaves out a lab-visible note whose author has not opted in", async () => {
    const { ctx, pi, member, labId, paperId } = await setup();
    await seedAnnotation(ctx, { labId, paperId, memberId: pi }, {
      body: "The PI's own note.",
    });
    await seedAnnotation(ctx, { labId, paperId, memberId: member }, {
      body: SECRET,
    });

    // The PI shares, which opts the PI in and nobody else.
    const { token } = await share(ctx, { paperId });
    const answer = asPaper(await publicView(ctx, { token }));

    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(answer.notes.map((note) => note.body)).toContain(
      "The PI's own note.",
    );
  });

  it("admits it the moment that member opts in themselves", async () => {
    const { ctx, member, labId, paperId } = await setup();
    await seedAnnotation(ctx, { labId, paperId, memberId: member }, {
      body: "Ben's critique.",
    });
    const { token } = await share(ctx, { paperId });
    expect(
      asPaper(await publicView(ctx, { token })).notes.map((note) => note.body),
    ).not.toContain("Ben's critique.");

    ctx.auth = { userId: member };
    await optIn(ctx, { paperId, included: true });

    const bodies = asPaper(await publicView(ctx, { token })).notes.map(
      (note) => note.body,
    );
    expect(bodies).toContain("Ben's critique.");
  });

  it("takes it back out when that member opts out again", async () => {
    const { ctx, member, labId, paperId } = await setup();
    await seedAnnotation(ctx, { labId, paperId, memberId: member }, {
      body: SECRET,
    });
    const { token } = await share(ctx, { paperId });

    ctx.auth = { userId: member };
    await optIn(ctx, { paperId, included: true });
    expect(JSON.stringify(await publicView(ctx, { token }))).toContain(SECRET);

    await optIn(ctx, { paperId, included: false });

    expect(JSON.stringify(await publicView(ctx, { token }))).not.toContain(
      SECRET,
    );
    // Presence is the consent: opting out leaves no row behind to read wrong.
    expect(ctx.db.all("paperShareOptIns")).toHaveLength(1);
  });

  it("never publishes an email address in place of a missing name", async () => {
    const { ctx, labId, paperId } = await setup();
    const nameless = await ctx.db.insert("users", {
      email: "someone@lab.example",
    });
    await ctx.db.insert("memberships", {
      labId,
      userId: nameless,
      role: "member",
      joinedAt: 1,
    });
    await seedAnnotation(ctx, { labId, paperId, memberId: nameless }, {
      body: "A note from somebody who never filled their name in.",
    });
    ctx.auth = { userId: nameless };
    await optIn(ctx, { paperId, included: true });
    const { token } = await share(ctx, { paperId });

    const answer = asPaper(await publicView(ctx, { token }));

    expect(JSON.stringify(answer)).not.toContain("someone@lab.example");
    expect(answer.notes.map((note) => note.authorName)).toContain(
      "A lab member",
    );
  });
});

/* -------------------------------------------------------------------------
 * 3. Withdrawal and the one redaction
 * ---------------------------------------------------------------------- */

describe("a withdrawn note", () => {
  it("disappears entirely when nothing hangs off it", async () => {
    const { ctx, pi, labId, paperId } = await setup();
    const noteId = await seedAnnotation(
      ctx,
      { labId, paperId, memberId: pi },
      { body: SECRET },
    );
    const { token } = await share(ctx, { paperId });
    await ctx.db.patch(noteId, { deletedAt: 5 });

    const answer = asPaper(await publicView(ctx, { token }));

    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(answer.notes.map((note) => note._id)).not.toContain(noteId);
  });

  it("shows its redaction sentence and nothing else when replies survive", async () => {
    const { ctx, pi, labId, paperId } = await setup();
    const parentId = await seedAnnotation(
      ctx,
      { labId, paperId, memberId: pi },
      { body: SECRET, quote: SECRET },
    );
    const replyId = await ctx.db.insert("annotations", {
      labId,
      paperId,
      memberId: pi,
      parentId,
      anchor: {
        quote: "incubation at 4°C",
        prefix: "",
        suffix: "",
        start: 0,
        end: 17,
        pageIndex: 2,
      },
      type: "note",
      body: "Answering the note above.",
      visibility: "lab",
    });
    const { token } = await share(ctx, { paperId });
    await ctx.db.patch(parentId, { deletedAt: 5 });

    const answer = asPaper(await publicView(ctx, { token }));
    const thread = answer.notes.find((note) => note._id === parentId);

    // The thread survives, because the reply is somebody's writing and
    // dropping the parent would drop it too.
    expect(thread).toBeDefined();
    expect(thread?.redacted).toBe(true);
    // "And nothing else": the sentence, and not one thing its author wrote.
    expect(thread?.body).toBe(REDACTED_NOTE_TEXT);
    expect(thread?.quote).toBe("");
    expect(thread?.authorName).toBe("");
    expect(thread?.status).toBeUndefined();
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(thread?.replies.map((reply) => reply._id)).toEqual([replyId]);
  });

  it("drops a reply whose own author has not opted in, with no marker left", async () => {
    const { ctx, pi, member, labId, paperId } = await setup();
    const parentId = await seedAnnotation(ctx, { labId, paperId, memberId: pi }, {
      body: "The PI's note.",
    });
    await ctx.db.insert("annotations", {
      labId,
      paperId,
      memberId: member,
      parentId,
      anchor: {
        quote: "incubation at 4°C",
        prefix: "",
        suffix: "",
        start: 0,
        end: 17,
        pageIndex: 2,
      },
      type: "note",
      body: SECRET,
      visibility: "lab",
    });
    const { token } = await share(ctx, { paperId });

    const answer = asPaper(await publicView(ctx, { token }));

    expect(JSON.stringify(answer)).not.toContain(SECRET);
    // Absence of consent is absence. A "a note was here" marker would publish
    // the shape of what the non-consenting member wrote.
    expect(answer.notes.find((note) => note._id === parentId)?.replies).toEqual(
      [],
    );
    expect(JSON.stringify(answer)).not.toContain(REDACTED_NOTE_TEXT);
  });
});

/* -------------------------------------------------------------------------
 * 4. Revocation
 * ---------------------------------------------------------------------- */

describe("revocation", () => {
  it("deads the page on the very next read", async () => {
    const { ctx, paperId } = await setup();
    const { token } = await share(ctx, { paperId });
    expect(await publicView(ctx, { token })).not.toBeNull();

    const live = (await panel(ctx, { paperId })).share;
    await takeDown(ctx, { shareId: live!._id });

    expect(await publicView(ctx, { token })).toBeNull();
  });

  it("deads the PDF with it", async () => {
    const { ctx, paperId } = await setup();
    const { token } = await share(ctx, { paperId });
    expect(await pdf(ctx, { token })).not.toBeNull();

    const live = (await panel(ctx, { paperId })).share;
    await takeDown(ctx, { shareId: live!._id });

    expect(await pdf(ctx, { token })).toBeNull();
  });

  it("is indistinguishable from a link that never existed", async () => {
    const { ctx, paperId } = await setup();
    const { token } = await share(ctx, { paperId });
    const live = (await panel(ctx, { paperId })).share;
    await takeDown(ctx, { shareId: live!._id });

    // Same answer, so a prober learns nothing from the difference.
    expect(await publicView(ctx, { token })).toBeNull();
    expect(
      await publicView(ctx, { token: "abcdefghijkmnpqrstuvwxyz23" }),
    ).toBeNull();
    expect(await publicView(ctx, { token: "not-a-token" })).toBeNull();
  });

  it("leaves the record of what was public, and files both facts", async () => {
    const { ctx, paperId } = await setup();
    await share(ctx, { paperId });
    const live = (await panel(ctx, { paperId })).share;
    await takeDown(ctx, { shareId: live!._id });

    const rows = ctx.db.all("shares");
    expect(rows).toHaveLength(1);
    expect(rowAt(rows).revokedAt).toBeTypeOf("number");

    const types = ctx.db.all("events").map((event) => event.type);
    expect(types).toContain("share.created");
    expect(types).toContain("share.revoked");
    // And nothing anywhere that records a read.
    expect(types.filter((type) => type.startsWith("share."))).not.toContain(
      "share.read",
    );
  });

  it("cannot be undone by minting a second link on the same paper", async () => {
    const { ctx, paperId } = await setup();
    const first = await share(ctx, { paperId });
    const second = await share(ctx, { paperId });

    // Idempotent: a second press is the same link, so revoking really revokes.
    expect(second.token).toBe(first.token);
    expect(ctx.db.all("shares")).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------
 * 5. The write-up, and its signature
 * ---------------------------------------------------------------------- */

describe("a write-up share", () => {
  it("is refused outright when nobody has signed one off", async () => {
    const { ctx, sessionId } = await setup();

    await expect(shareWriteUp(ctx, { sessionId })).rejects.toThrow(ConvexError);
    expect(ctx.db.all("shares")).toHaveLength(0);
  });

  it("deads if the sign-off is taken away afterwards", async () => {
    const { ctx, sessionId } = await setup();
    await ctx.db.patch(sessionId, {
      synthesis: "## What we worked out\n\n- The 4°C step is the difference.",
      synthesisApprovedAt: 100,
      synthesisCitedAnnotationIds: [],
    });
    const { token } = await shareWriteUp(ctx, { sessionId });
    expect(await publicView(ctx, { token })).not.toBeNull();

    await ctx.db.patch(sessionId, { synthesisApprovedAt: undefined });

    expect(await publicView(ctx, { token })).toBeNull();
  });

  it("deads when a note it was checked against stops being shared", async () => {
    const { ctx, pi, labId, paperId, sessionId } = await setup();
    const citedId = await seedAnnotation(
      ctx,
      { labId, paperId, memberId: pi },
      { body: SECRET },
    );
    await ctx.db.patch(sessionId, {
      synthesis: "## What we worked out\n\n- The 4°C step is the difference.",
      synthesisApprovedAt: 100,
      synthesisCitedAnnotationIds: [citedId],
    });
    const { token } = await shareWriteUp(ctx, { sessionId });
    expect(await publicView(ctx, { token })).not.toBeNull();

    // The lab's own surface would keep showing this with a banner over it and
    // ask its authors to review it. There is nobody to ask out here, and no
    // per-line remedy for prose, so the whole link goes.
    await ctx.db.patch(citedId, { visibility: "private" });

    expect(await publicView(ctx, { token })).toBeNull();
  });

  it("comes back by itself once the lab re-approves", async () => {
    const { ctx, pi, labId, paperId, sessionId } = await setup();
    const citedId = await seedAnnotation(ctx, { labId, paperId, memberId: pi });
    await ctx.db.patch(sessionId, {
      synthesis: "## What we worked out",
      synthesisApprovedAt: 100,
      synthesisCitedAnnotationIds: [citedId],
    });
    const { token } = await shareWriteUp(ctx, { sessionId });
    await ctx.db.patch(citedId, { visibility: "private" });
    expect(await publicView(ctx, { token })).toBeNull();

    // Re-approving against the margin as it stands now: the snapshot no longer
    // names the note that went away.
    await ctx.db.patch(sessionId, {
      synthesisApprovedAt: 200,
      synthesisCitedAnnotationIds: [],
    });

    expect(await publicView(ctx, { token })).not.toBeNull();
  });

  it("carries the signed copy and never the draft", async () => {
    const { ctx, sessionId, labId } = await setup();
    await ctx.db.insert("syntheses", {
      sessionId,
      labId,
      sections: [
        {
          key: "summary",
          heading: "Summary",
          items: [{ text: SECRET, attribution: [], annotationIds: [] }],
        },
      ],
      model: "test",
      generatedAt: 1,
      generatedBy: rowAt(ctx.db.all("users"))._id as Id<"users">,
    });
    await ctx.db.patch(sessionId, {
      synthesis: "## What we worked out\n\n- The 4°C step is the difference.",
      synthesisApprovedAt: 100,
      synthesisCitedAnnotationIds: [],
    });
    const { token } = await shareWriteUp(ctx, { sessionId });

    const answer = await publicView(ctx, { token });

    // The draft is a model's rearrangement that nobody signed. Only the copy a
    // person read, edited and put the lab's name on leaves the building.
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(answer?.kind).toBe("synthesis");
  });

  it("is not something an ordinary member may publish", async () => {
    const { ctx, member, sessionId } = await setup();
    await ctx.db.patch(sessionId, {
      synthesis: "## What we worked out",
      synthesisApprovedAt: 100,
    });
    ctx.auth = { userId: member };

    await expect(shareWriteUp(ctx, { sessionId })).rejects.toThrow(ConvexError);
  });
});

/* -------------------------------------------------------------------------
 * 6. The membership gate on everything that is not the public read
 * ---------------------------------------------------------------------- */

describe("the authed side", () => {
  it("refuses a stranger who is in no lab", async () => {
    const { ctx, paperId } = await setup();
    const outsider = await ctx.db.insert("users", { name: "Nobody" });
    ctx.auth = { userId: outsider };

    await expect(share(ctx, { paperId })).rejects.toThrow(ConvexError);
    await expect(panel(ctx, { paperId })).rejects.toThrow(ConvexError);
    await expect(optIn(ctx, { paperId, included: true })).rejects.toThrow(
      ConvexError,
    );
  });

  it("lets the PI take down a link somebody else made", async () => {
    const { ctx, pi, member, paperId } = await setup();
    ctx.auth = { userId: member };
    await share(ctx, { paperId });
    const asMember = await panel(ctx, { paperId });
    expect(asMember.share?.canRevoke).toBe(true);

    ctx.auth = { userId: pi };
    const asPi = await panel(ctx, { paperId });
    expect(asPi.share?.canRevoke).toBe(true);
    await expect(takeDown(ctx, { shareId: asPi.share!._id })).resolves.toBeNull();
  });

  it("shows every member the link and their own answer about it", async () => {
    const { ctx, member, paperId } = await setup();
    await share(ctx, { paperId });

    ctx.auth = { userId: member };
    const seen = await panel(ctx, { paperId });

    // The people whose writing could end up on the other end of a link are the
    // ones owed the knowledge that it exists.
    expect(seen.share).not.toBeNull();
    expect(seen.optedIn).toBe(false);
    expect(seen.optedInCount).toBe(1);
  });
});

/* -------------------------------------------------------------------------
 * 7. The schema's own promises
 * ---------------------------------------------------------------------- */

describe("the shares table", () => {
  it("is reachable by token and never by anything that could list it", () => {
    const names = indexesOf(schema.tables.shares).map(
      (index) => index.indexDescriptor,
    );

    expect(names).toContain("by_token");
    // No `by_lab`, no `by_creation_time` sweep: there is deliberately no index
    // that answers "what is public", because there is no surface that asks.
    expect(names).not.toContain("by_lab");
  });

  it("keeps the token out of the ledger", () => {
    // `events` rows are never deleted, so a token written into one would
    // outlive every revocation — exactly the argument that keeps the Slack
    // webhook URL out of `slack.delivery_changed`.
    const wire = JSON.stringify(wireForm(schema.tables.events.validator));
    expect(wire).toContain("share.created");
    expect(wire).toContain("share.revoked");
    expect(wire).not.toContain("token");
  });
});
