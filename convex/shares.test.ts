import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import {
  FakeCtx,
  handlerOf,
  rowAt,
  seedAnnotation,
  seedLab,
} from "./delegations.fixtures";
import {
  REDACTED_NOTE_TEXT,
  admitShare,
  forPaper,
  forSession,
  pdfForShare,
  revoke,
  setPaperOptIn,
  sharePaper,
  sweepRateWindows,
  shareSynthesis,
  view,
} from "./shares";
import {
  continueOptInSweep,
  leaveLab as leaveLabMutation,
} from "./labs";
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
      notes: {
        _id: Id<"annotations">;
        authorName: string;
        body: string;
        quote: string;
        pageIndex: number;
        createdAt: number;
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
const sessionPanel = call<
  { sessionId: Id<"sessions"> },
  { share: { _id: Id<"shares">; token: string } | null; approved: boolean; canShare: boolean }
>(forSession);
const leaveLab = call<{ labId: Id<"labs"> }, null>(leaveLabMutation);
const continueSweep = call<
  { userId: Id<"users">; labId: Id<"labs">; departedAt: number },
  null
>(continueOptInSweep);
const pdf = call<
  { token: string },
  { storageId: Id<"_storage">; title: string } | null
>(pdfForShare);
const admitPdf = call<{ token: string }, "ok" | "busy" | "dead">(admitShare);
const sweepWindows = call<Record<string, never>, null>(sweepRateWindows);

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

  it("leaves nothing at all where a non-consenting root stood, and promotes its replies", async () => {
    const { ctx, pi, member, labId, paperId } = await setup();
    // Marcus writes the note; Elena replies. Elena shares, which opts in Elena
    // and nobody else — so the root is his and he has never agreed to it.
    const parentId = await seedAnnotation(
      ctx,
      { labId, paperId, memberId: member },
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

    const answer = asPaper(await publicView(ctx, { token }));

    // Not a marker, not a placeholder, not an id: a reader must not be able to
    // learn that a member who declined wrote something here, or when.
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(JSON.stringify(answer)).not.toContain(REDACTED_NOTE_TEXT);
    expect(JSON.stringify(answer)).not.toContain(parentId);
    expect(answer.notes.map((note) => note._id)).not.toContain(parentId);

    // Elena's reply is her own writing and she said yes, so it stands alone.
    const promoted = answer.notes.find((note) => note._id === replyId);
    expect(promoted).toBeDefined();
    expect(promoted?.body).toBe("Answering the note above.");
    expect(promoted?.redacted).toBe(false);
    expect(promoted?.replies).toEqual([]);
  });

  it("does not carry a withdrawn note's own timestamp on its marker", async () => {
    const { ctx, pi, labId, paperId } = await setup();
    const parentId = await seedAnnotation(ctx, { labId, paperId, memberId: pi });
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
    const root = await ctx.db.get(parentId);
    const reply = await ctx.db.get(replyId);
    await ctx.db.patch(parentId, { deletedAt: 5 });

    const answer = asPaper(await publicView(ctx, { token }));
    const marker = answer.notes.find((note) => note._id === parentId);

    expect(marker?.redacted).toBe(true);
    // The minute somebody wrote a note is a fact about their working day, and
    // it does not survive the note it belonged to.
    expect(marker?.createdAt).not.toBe(root?._creationTime);
    expect(marker?.createdAt).toBe(reply?._creationTime);
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

  it("deads when the record does not say what it was checked against", async () => {
    const { ctx, pi, labId, paperId, sessionId } = await setup();
    const citedId = await seedAnnotation(
      ctx,
      { labId, paperId, memberId: pi },
      { body: SECRET },
    );
    await ctx.db.patch(sessionId, {
      synthesis: "## What we worked out",
      synthesisApprovedAt: 100,
      synthesisCitedAnnotationIds: [citedId],
    });
    const { token } = await shareWriteUp(ctx, { sessionId });
    expect(await publicView(ctx, { token })).not.toBeNull();

    // The shape of a record approved before the snapshot field existed. Read as
    // an empty list it would sail through the withdrawal check having never
    // been subjected to one — so an absent snapshot deads the link instead.
    await ctx.db.patch(sessionId, {
      synthesisCitedAnnotationIds: undefined,
    });

    expect(await publicView(ctx, { token })).toBeNull();

    // And it stays dead however private the notes behind it become, because
    // the link was never claiming anything checkable in the first place.
    await ctx.db.patch(citedId, { visibility: "private" });
    expect(await publicView(ctx, { token })).toBeNull();
  });

  it("will not mint against a signature that has been cleared", async () => {
    const { ctx, sessionId } = await setup();
    // Text without a signature: a draft somebody approved and then un-approved.
    await ctx.db.patch(sessionId, {
      synthesis: "## What we worked out",
      synthesisCitedAnnotationIds: [],
    });

    await expect(shareWriteUp(ctx, { sessionId })).rejects.toThrow(ConvexError);
    // No row, and no ledger entry claiming the lab published something.
    expect(ctx.db.all("shares")).toHaveLength(0);
    expect(ctx.db.all("events").map((event) => event.type)).not.toContain(
      "share.created",
    );
  });

  it("will not mint a link the reader would be 404'd from on arrival", async () => {
    const { ctx, sessionId } = await setup();
    // Signed off, but with no record of what the copy was checked against —
    // the shape `approvedWriteUp` deads on read.
    await ctx.db.patch(sessionId, {
      synthesis: "## What we worked out",
      synthesisApprovedAt: 100,
      synthesisCitedAnnotationIds: undefined,
    });

    // The mint used to ask a weaker question than the read: text plus a
    // signature, skipping the snapshot. It handed back a token, ledgered it,
    // and told the member they had published — for a page that had never once
    // been readable.
    await expect(shareWriteUp(ctx, { sessionId })).rejects.toThrow(ConvexError);
    expect(ctx.db.all("shares")).toHaveLength(0);
    expect(ctx.db.all("events").map((event) => event.type)).not.toContain(
      "share.created",
    );
  });

  it("will not mint while a note the copy cites has been withdrawn", async () => {
    const { ctx, pi, labId, paperId, sessionId } = await setup();
    const citedId = await seedAnnotation(
      ctx,
      { labId, paperId, memberId: pi },
      { body: SECRET },
    );
    await ctx.db.patch(sessionId, {
      synthesis: "## What we worked out",
      synthesisApprovedAt: 100,
      synthesisCitedAnnotationIds: [citedId],
    });
    await ctx.db.patch(citedId, { visibility: "private" });

    // Same predicate as the read, so mint and read cannot drift apart again.
    await expect(shareWriteUp(ctx, { sessionId })).rejects.toThrow(ConvexError);
    expect(ctx.db.all("shares")).toHaveLength(0);
    // And no ledger row claiming the lab published something it did not.
    expect(ctx.db.all("events").map((event) => event.type)).not.toContain(
      "share.created",
    );
  });

  it("does not offer a button whose mutation could only fail", async () => {
    const { ctx, pi, labId, paperId, sessionId } = await setup();
    const citedId = await seedAnnotation(
      ctx,
      { labId, paperId, memberId: pi },
      { body: SECRET },
    );
    await ctx.db.patch(sessionId, {
      synthesis: "## What we worked out",
      synthesisApprovedAt: 100,
      synthesisCitedAnnotationIds: [citedId],
    });
    expect((await sessionPanel(ctx, { sessionId })).approved).toBe(true);

    // Signed, and unpublishable. The panel used to read the signature alone,
    // so it kept offering the control after the copy stopped being shareable —
    // and the mutation behind it could only reject.
    await ctx.db.patch(citedId, { visibility: "private" });
    expect((await sessionPanel(ctx, { sessionId })).approved).toBe(false);

    await ctx.db.patch(sessionId, { synthesisCitedAnnotationIds: undefined });
    expect((await sessionPanel(ctx, { sessionId })).approved).toBe(false);
  });

  it("does not offer the control while only a draft exists", async () => {
    const { ctx, sessionId } = await setup();
    await ctx.db.patch(sessionId, { synthesis: "## What we worked out" });

    const panelState = await sessionPanel(ctx, { sessionId });

    // The panel asked `synthesis !== undefined` and would have offered a link
    // that minted a token whose page 404s.
    expect(panelState.approved).toBe(false);
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
    expect(answer === null || "busy" in answer ? null : answer.kind).toBe(
      "synthesis",
    );
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

describe("leaving the lab", () => {
  it("withdraws the departing member's consent, because they can no longer reach it", async () => {
    const { ctx, pi, member, labId, paperId } = await setup();
    await seedAnnotation(ctx, { labId, paperId, memberId: member }, {
      body: SECRET,
    });
    ctx.auth = { userId: member };
    await optIn(ctx, { paperId, included: true });
    ctx.auth = { userId: pi };
    const { token } = await share(ctx, { paperId });
    expect(JSON.stringify(await publicView(ctx, { token }))).toContain(SECRET);

    ctx.auth = { userId: member };
    await leaveLab(ctx, { labId });

    // Their writing stops being published in the same act that takes away
    // their ability to stop it.
    expect(JSON.stringify(await publicView(ctx, { token }))).not.toContain(
      SECRET,
    );
    expect(ctx.db.all("paperShareOptIns").map((row) => row.userId)).not.toContain(
      member,
    );
  });

  it("stops publishing an ex-member at once, not when the sweep catches up", async () => {
    const { ctx, pi, member, labId, paperId } = await setup();
    await seedAnnotation(
      ctx,
      { labId, paperId, memberId: member },
      { body: SECRET },
    );
    ctx.auth = { userId: member };
    await optIn(ctx, { paperId, included: true });
    // Past one batch, so the sweep cannot finish inside the departure.
    for (let i = 0; i < 300; i++) {
      const other = await ctx.db.insert("papers", {
        labId,
        title: `Paper ${i}`,
        addedBy: member,
        ingestStatus: "ready",
      });
      await ctx.db.insert("paperShareOptIns", {
        labId,
        paperId: other,
        userId: member,
        optedInAt: 1,
      });
    }
    ctx.auth = { userId: pi };
    const { token } = await share(ctx, { paperId });
    expect(JSON.stringify(await publicView(ctx, { token }))).toContain(SECRET);

    ctx.auth = { userId: member };
    await leaveLab(ctx, { labId });

    // The whole finding. Their opt-in row for *this* paper may or may not have
    // been in the first batch, and the continuation has not run — so if the
    // read trusted the rows alone, a departed member's writing would go on
    // being published to strangers until a background job caught up, or
    // forever if it died. Consent is the row *and* current membership, asked
    // on the read, so departure lands on the very next load.
    expect(
      ctx.scheduled.filter((job) => job.name.includes("continueOptInSweep")),
    ).toHaveLength(1);
    expect(JSON.stringify(await publicView(ctx, { token }))).not.toContain(
      SECRET,
    );
  });

  it("cannot be blocked by a member who opted in to too much", async () => {
    const { ctx, member, labId } = await setup();
    // Two full batches and nothing over, which is the termination case worth
    // pinning: a sweep that stopped only on a short batch would schedule one
    // last job that finds nothing, and a sweep that never scheduled on a full
    // batch would silently leave rows behind.
    for (let i = 0; i < 512; i++) {
      const paperId = await ctx.db.insert("papers", {
        labId,
        title: `Paper ${i}`,
        addedBy: member,
        ingestStatus: "ready",
      });
      await ctx.db.insert("paperShareOptIns", {
        labId,
        paperId,
        userId: member,
        optedInAt: 1,
      });
    }

    ctx.auth = { userId: member };
    await leaveLab(ctx, { labId });

    // The departure itself completed — the membership is gone regardless of
    // how much consent is left to sweep.
    expect(
      ctx.db.all("memberships").filter((row) => row.userId === member),
    ).toEqual([]);

    const mine = () =>
      ctx.db.all("paperShareOptIns").filter((row) => row.userId === member);

    // Drain it the way the scheduler would, and count the rounds rather than
    // invoking one and calling it proved.
    let rounds = 0;
    let pending = ctx.scheduled.filter((job) =>
      job.name.includes("continueOptInSweep"),
    );
    while (pending.length > 0) {
      rounds++;
      expect(rounds, "the sweep rescheduled itself forever").toBeLessThan(10);
      const next = pending[pending.length - 1]!;
      ctx.scheduled.length = 0;
      await continueSweep(
        ctx,
        next.args as {
          userId: Id<"users">;
          labId: Id<"labs">;
          departedAt: number;
        },
      );
      pending = ctx.scheduled.filter((job) =>
        job.name.includes("continueOptInSweep"),
      );
    }

    expect(mine()).toEqual([]);
    // 512 = 256 + 256 + an empty round: the exactly-full batch cannot tell it
    // is the last one, so it schedules once more and that round finds nothing.
    expect(rounds).toBe(2);
  });

  it("buries pre-departure consent even when the member comes back", async () => {
    vi.useFakeTimers();
    try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { ctx, member, labId, paperId } = await setup();
    ctx.auth = { userId: member };
    // The siblings go in first so that `paperId`'s row falls past the first
    // batch. That ordering is the whole point: the row the member re-affirms
    // has to still be there when they re-affirm it, so the decision lands as a
    // patch on an old row rather than a fresh insert — which is the case the
    // early-return used to get wrong and a `freshPaper`-only test cannot see.
    for (let i = 0; i < 300; i++) {
      const other = await ctx.db.insert("papers", {
        labId,
        title: `Paper ${i}`,
        addedBy: member,
        ingestStatus: "ready",
      });
      await ctx.db.insert("paperShareOptIns", {
        labId,
        paperId: other,
        userId: member,
        optedInAt: 1,
      });
    }
    // Consent given before leaving, on the paper they will re-open later.
    await optIn(ctx, { paperId, included: true });
    // A month later, they leave.
    vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
    await leaveLab(ctx, { labId });

    const followUp = ctx.scheduled.filter((job) =>
      job.name.includes("continueOptInSweep"),
    )[0]!;

    // A month after that, they are re-invited — before the continuation has
    // run, so the rest of their pre-departure rows are still sitting there.
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    await ctx.db.insert("memberships", {
      labId,
      userId: member,
      role: "member",
      joinedAt: 2,
    });
    // They re-open the *same* paper they had opened before leaving. The row
    // exists, so this re-affirmation is a patch, and the stamp it carries is
    // the only thing standing between a decision made minutes ago and a sweep
    // that deletes by a cutoff a month older.
    await optIn(ctx, { paperId, included: true });
    // And one they had never touched, which can only be a fresh insert.
    const freshPaper = await ctx.db.insert("papers", {
      labId,
      title: "Read after coming back",
      addedBy: member,
      ingestStatus: "ready",
    });
    await optIn(ctx, { paperId: freshPaper, included: true });

    // Drain the sweep the way the scheduler would.
    let pending = [followUp];
    for (let round = 0; pending.length > 0 && round < 10; round++) {
      const next = pending[pending.length - 1]!;
      ctx.scheduled.length = 0;
      await continueSweep(
        ctx,
        next.args as {
          userId: Id<"users">;
          labId: Id<"labs">;
          departedAt: number;
        },
      );
      pending = ctx.scheduled.filter((job) =>
        job.name.includes("continueOptInSweep"),
      );
    }

    const mine = ctx.db
      .all("paperShareOptIns")
      .filter((row) => row.userId === member);

    // The finding, all three halves. Aborting on rejoin would have left every
    // pre-departure row in place — and those rows come back to life the moment
    // the membership does, republishing a year-old margin nobody re-consented
    // to. A cutoff that ignored the rejoin would have deleted the fresh choice
    // they had just made. And a re-affirmation that left the old stamp alone
    // would have let the continuation delete `paperId` as pre-departure
    // consent, when the member had said yes to it a month after leaving.
    expect(mine.map((row) => row.paperId)).toEqual([paperId, freshPaper]);
    expect(mine).toHaveLength(2);
    // The surviving row is the original, restamped — not a replacement.
    expect(mine[0]!.optedInAt).toBe(new Date("2026-03-01T00:00:00Z").getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps nothing of an ex-member who never came back", async () => {
    const { ctx, member, labId, paperId } = await setup();
    ctx.auth = { userId: member };
    await optIn(ctx, { paperId, included: true });
    await leaveLab(ctx, { labId });

    expect(
      ctx.db.all("paperShareOptIns").filter((row) => row.userId === member),
    ).toEqual([]);
  });

  it("says nothing about a lab the member has not left", async () => {
    const { ctx, member, labId, paperId } = await setup();
    const otherLab = await ctx.db.insert("labs", {
      name: "Second Lab",
      createdBy: member,
      memberCount: 1,
    });
    await ctx.db.insert("memberships", {
      labId: otherLab,
      userId: member,
      role: "member",
      joinedAt: 1,
    });
    const otherPaper = await ctx.db.insert("papers", {
      labId: otherLab,
      title: "Another paper",
      addedBy: member,
      ingestStatus: "ready",
    });
    ctx.auth = { userId: member };
    await optIn(ctx, { paperId, included: true });
    await optIn(ctx, { paperId: otherPaper, included: true });

    await leaveLab(ctx, { labId });

    const remaining = ctx.db
      .all("paperShareOptIns")
      .filter((row) => row.userId === member);
    expect(remaining.map((row) => row.paperId)).toEqual([otherPaper]);
  });
});

describe("taking a link down", () => {
  it("lets any member close a paper link, whoever opened it", async () => {
    const { ctx, member, paperId } = await setup();
    // The PI mints it; an ordinary member takes it down.
    await share(ctx, { paperId });

    ctx.auth = { userId: member };
    const seen = await panel(ctx, { paperId });
    expect(seen.share?.canRevoke).toBe(true);
    await expect(
      takeDown(ctx, { shareId: seen.share!._id }),
    ).resolves.toBeNull();

    expect(await publicView(ctx, { token: seen.share!.token })).toBeNull();
  });

  it("keeps a write-up link with the people who could have published it", async () => {
    const { ctx, member, sessionId } = await setup();
    await ctx.db.patch(sessionId, {
      synthesis: "## What we worked out",
      synthesisApprovedAt: 100,
      synthesisCitedAnnotationIds: [],
    });
    const created = await shareWriteUp(ctx, { sessionId });
    expect(created.token).toBeTypeOf("string");

    ctx.auth = { userId: member };
    const seen = await sessionPanel(ctx, { sessionId });
    await expect(
      takeDown(ctx, { shareId: seen.share!._id }),
    ).rejects.toThrow(ConvexError);
  });
});

describe("the abuse guard", () => {
  /**
   * The guard lives on the PDF route, and only there.
   *
   * `shares.view` is a plain query and is deliberately unthrottled: making it
   * a mutation so it could write a counter put a thousand-row annotation scan
   * inside a write transaction, where every anonymous read collided with the
   * lab's own writing, and spent a transaction on renders Next never
   * delivered. Convex caches the query instead. What actually costs money is
   * streaming the file with `no-store` on every request, and that is what is
   * counted here.
   */
  async function fetchPdf(ctx: FakeCtx, token: string): Promise<boolean> {
    return (await admitPdf(ctx, { token })) === "ok";
  }

  it("serves a popular link and refuses a hammered one", async () => {
    const { ctx, paperId } = await setup();
    const { token } = await share(ctx, { paperId });

    // Well inside the ceiling: a link doing brisk traffic is not an attack.
    for (let i = 0; i < 100; i++) {
      expect(await fetchPdf(ctx, token)).toBe(true);
    }

    let refused = false;
    for (let i = 0; i < 5_000 && !refused; i++) {
      refused = !(await fetchPdf(ctx, token));
    }
    expect(refused, "the guard never refused a link under 5000 fetches").toBe(
      true,
    );

    // The page is untouched by any of it. A reader holding a good link must
    // still get the margin — the throttle guards bytes, not the story.
    const still = await publicView(ctx, { token });
    expect(still).not.toBeNull();
    expect((still as { kind: string }).kind).toBe("paper");
  });

  it("holds the ceiling it documents, rather than a fraction of it", async () => {
    vi.useFakeTimers();
    try {
      // Mid-minute on purpose: the window is aligned to the clock, not to
      // whenever the first fetch happened to land, so starting here must not
      // shorten the window or shrink what it admits.
      vi.setSystemTime(new Date("2026-08-18T12:00:37Z"));
      const { ctx, paperId } = await setup();
      const { token } = await share(ctx, { paperId });

      let served = 0;
      for (let i = 0; i < 5_000; i++) {
        if (!(await fetchPdf(ctx, token))) break;
        served++;
      }
      expect(served).toBe(600);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps one row per link and resets it in place", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));
      const { ctx, paperId } = await setup();
      const { token } = await share(ctx, { paperId });
      while (await fetchPdf(ctx, token)) {
        /* up to the ceiling */
      }
      expect(ctx.db.all("shareRateWindows")).toHaveLength(1);

      vi.setSystemTime(new Date("2026-08-18T12:01:30Z"));
      expect(await fetchPdf(ctx, token)).toBe(true);

      // The ended window is overwritten rather than left beside a new one, so
      // the earlier minute's timestamp is gone the moment anybody comes back.
      // What remains is the current minute and a count — which is exactly what
      // the table's comment claims, no more.
      const rows = ctx.db.all("shareRateWindows");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.windowStart).toBe(Date.parse("2026-08-18T12:01:00Z"));
      expect(rows[0]?.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the cron take the counters of links nobody came back to", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));
      const { ctx, paperId } = await setup();
      const { token } = await share(ctx, { paperId });
      await fetchPdf(ctx, token);
      expect(ctx.db.all("shareRateWindows")).toHaveLength(1);

      // A live link's row is overwritten by its next fetch; this is the other
      // case. Without the cron, one number and one minute would sit here for
      // as long as the link went untouched, and the schema's promise about
      // what survives at rest would be bounded by nothing.
      vi.setSystemTime(new Date("2026-08-18T12:40:00Z"));
      await sweepWindows(ctx, {});

      expect(ctx.db.all("shareRateWindows")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps sweeping until the backlog is gone", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));
      const { ctx, paperId } = await setup();
      const { token } = await share(ctx, { paperId });
      const shareRow = (await panel(ctx, { paperId })).share!;
      // More stale windows than one batch clears. A single bounded pass with
      // nothing behind it makes the retention promise false exactly when it
      // matters: a busy deployment strands the remainder past the interval the
      // schema comment advertises, and the backlog grows from there.
      for (let i = 0; i < 512; i++) {
        await ctx.db.insert("shareRateWindows", {
          shareId: shareRow._id,
          windowStart: Date.parse("2026-08-18T11:00:00Z"),
          count: 1,
        });
      }
      void token;

      vi.setSystemTime(new Date("2026-08-18T12:40:00Z"));
      let rounds = 0;
      let pending = true;
      while (pending) {
        rounds++;
        expect(rounds, "the sweep rescheduled itself forever").toBeLessThan(10);
        ctx.scheduled.length = 0;
        await sweepWindows(ctx, {});
        pending = ctx.scheduled.some((job) =>
          job.name.includes("sweepRateWindows"),
        );
      }

      expect(ctx.db.all("shareRateWindows")).toEqual([]);
      // 512 = 500 + 12, so the second round is the short one that stops it.
      expect(rounds).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not sweep a counter that is still the current minute", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-18T12:00:10Z"));
      const { ctx, paperId } = await setup();
      const { token } = await share(ctx, { paperId });
      await fetchPdf(ctx, token);

      vi.setSystemTime(new Date("2026-08-18T12:00:50Z"));
      await sweepWindows(ctx, {});

      // Sweeping the live window would hand a hammered link a fresh ceiling
      // every time the cron happened to fire.
      expect(ctx.db.all("shareRateWindows")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cannot be made to write anything by somebody guessing tokens", async () => {
    const { ctx } = await setup();

    for (const guess of [
      "abcdefghijkmnpqrstuvwxyz23",
      "zzzzzzzzzzzzzzzzzzzzzzzzzz",
      "not-a-token",
    ]) {
      expect(await publicView(ctx, { token: guess })).toBeNull();
      expect(await admitPdf(ctx, { token: guess })).toBe("dead");
    }

    // A row per guessed token would be a storage denial-of-service wearing the
    // costume of a rate limiter.
    expect(ctx.db.all("shareRateWindows")).toEqual([]);
  });

  it("writes nothing at all when the page is read", async () => {
    const { ctx, paperId } = await setup();
    const { token } = await share(ctx, { paperId });

    for (let i = 0; i < 20; i++) {
      expect(await publicView(ctx, { token })).not.toBeNull();
    }

    // The whole point of reverting the mutation. A public page read touches
    // no document, so it cannot conflict with a member annotating the paper
    // and cannot be spent by a render nobody receives.
    expect(ctx.db.all("shareRateWindows")).toEqual([]);
  });

  it("tells a revoked link apart from a throttled one", async () => {
    const { ctx, paperId } = await setup();
    const { token } = await share(ctx, { paperId });
    expect(await admitPdf(ctx, { token })).toBe("ok");

    const live = (await panel(ctx, { paperId })).share;
    await takeDown(ctx, { shareId: live!._id });

    // Not "busy". A link revoked between the route's lookup and its admission
    // is dead, and telling that reader to come back later would be both false
    // and an oracle — it would distinguish "revoked a moment ago" from "never
    // existed", which the 404 exists to prevent.
    expect(await admitPdf(ctx, { token })).toBe("dead");
  });

  it("forgets the count when the link is taken down", async () => {
    const { ctx, paperId } = await setup();
    const { token } = await share(ctx, { paperId });
    await fetchPdf(ctx, token);
    expect(ctx.db.all("shareRateWindows")).toHaveLength(1);

    const live = (await panel(ctx, { paperId })).share;
    await takeDown(ctx, { shareId: live!._id });

    expect(ctx.db.all("shareRateWindows")).toEqual([]);
  });

  it("counts links, and has nothing in it that could count people", () => {
    const fields = Object.keys(
      (
        wireForm(schema.tables.shareRateWindows.validator) as {
          value: Record<string, unknown>;
        }
      ).value,
    ).sort();

    // The whole assertion. There is no user, no session, no address, no
    // fingerprint and no per-read row — so the question "who read this" has no
    // answer here, structurally, rather than by anybody's restraint.
    expect(fields).toEqual(["count", "shareId", "windowStart"]);
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
