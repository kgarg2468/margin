import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
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
  attachImportedPdf,
  copySharedPdf,
  forPaper,
  forSession,
  importFromShare,
  pdfForShare,
  revoke,
  setPaperOptIn,
  sharePaper,
  sharedPdfSource,
  sweepRateWindows,
  shareSynthesis,
  view,
} from "./shares";
import {
  continueOptInSweep,
  leaveLab as leaveLabMutation,
} from "./labs";
import schema from "./schema";
import { decideSharedPdf } from "../lib/shares/pdf-order";

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
      pdf: "included" | "withheld" | "none";
      pageCount?: number;
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

const share = call<
  { paperId: Id<"papers">; includePdf?: boolean },
  { token: string }
>(sharePaper);
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
    share: {
      _id: Id<"shares">;
      token: string;
      canRevoke: boolean;
      includePdf: boolean;
    } | null;
    optedIn: boolean;
    optedInCount: number;
    hasPdf: boolean;
  }
>(forPaper);
const sessionPanel = call<
  { sessionId: Id<"sessions"> },
  {
    share: {
      _id: Id<"shares">;
      token: string;
      includePdf: boolean;
    } | null;
    approved: boolean;
    canShare: boolean;
  }
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
    // Minted with the file included, because a link without it has no PDF to
    // dead and would pass this test for the wrong reason.
    const { token } = await share(ctx, { paperId, includePdf: true });
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
 * 4b. The file, which is somebody else's to give away
 * ---------------------------------------------------------------------- */

describe("the PDF gate", () => {
  it("withholds the file unless the sharer asked for it", async () => {
    const { ctx, paperId } = await setup();
    await ctx.db.patch(paperId, { pageCount: 37 });
    const { token } = await share(ctx, { paperId });

    expect(await pdf(ctx, { token })).toBeNull();
    // The page still carries the whole margin — only the file is missing.
    const answer = asPaper(await publicView(ctx, { token }));
    expect(answer.pdf).toBe("withheld");
    // And nothing derived from the file goes out either. A page count is read
    // off the PDF, so publishing it here would be the withheld artifact
    // talking through a field nobody thought of as the file.
    expect(answer.pageCount).toBeUndefined();
  });

  it("sends the file when the sharer asked for it", async () => {
    const { ctx, paperId } = await setup();
    await ctx.db.patch(paperId, { pageCount: 37 });
    const { token } = await share(ctx, { paperId, includePdf: true });

    expect(await pdf(ctx, { token })).not.toBeNull();
    const answer = asPaper(await publicView(ctx, { token }));
    expect(answer.pdf).toBe("included");
    expect(answer.pageCount).toBe(37);
  });

  it("treats an explicit no exactly as an unasked question", async () => {
    const { ctx, paperId } = await setup();
    const { token } = await share(ctx, { paperId, includePdf: false });

    expect(await pdf(ctx, { token })).toBeNull();
    const row = ctx.db.all("shares")[0]!;
    expect(row.kind === "paper" && row.includePdf).toBe(false);
  });

  it("withholds the file from a link minted before the question existed", async () => {
    const { ctx, paperId, labId, pi } = await setup();
    // A row as it would have been written before this field: no answer at all.
    // Absent has to read as no, or shipping the field would have published
    // every link already out there.
    await ctx.db.insert("shares", {
      kind: "paper",
      token: "abcdefghijkmnpqrstuvwxyz23",
      labId,
      paperId,
      createdBy: pi,
      createdAt: Date.now(),
    });

    expect(
      await pdf(ctx, { token: "abcdefghijkmnpqrstuvwxyz23" }),
    ).toBeNull();
  });

  it("still opens a link minted before the question existed", async () => {
    // The other half of absent-means-no, and the half that would break
    // quietly. Withholding the file must not dead the link: a pre-feature
    // share still resolves, still says which state it is in, and still carries
    // the margin it was made to publish. A future read that treated a missing
    // field as a malformed row and 404'd would pass the test above and fail
    // this one, which is the point of writing it down.
    const { ctx, paperId, labId, pi } = await setup();
    await seedAnnotation(ctx, { labId, paperId, memberId: pi }, {
      body: "The legacy link still carries this.",
    });
    // The author's own consent, given the way the mint normally gives it.
    await optIn(ctx, { paperId, included: true });

    await ctx.db.insert("shares", {
      kind: "paper",
      token: "abcdefghijkmnpqrstuvwxyz23",
      labId,
      paperId,
      createdBy: pi,
      createdAt: Date.now(),
    });

    const answer = asPaper(
      await publicView(ctx, { token: "abcdefghijkmnpqrstuvwxyz23" }),
    );
    expect(answer.pdf).toBe("withheld");
    expect(answer.notes.map((note) => note.body)).toContain(
      "The legacy link still carries this.",
    );
  });

  it("tells a withheld file from one the library never had", async () => {
    const { ctx, labId, pi } = await setup();
    const bare = await ctx.db.insert("papers", {
      labId,
      title: "Metadata only",
      addedBy: pi,
      ingestStatus: "needs-pdf",
    });
    const { token } = await share(ctx, {
      paperId: bare,
      // Asked for, and still absent: there is nothing to send.
      includePdf: true,
    });

    expect(asPaper(await publicView(ctx, { token })).pdf).toBe("none");
    expect(await pdf(ctx, { token })).toBeNull();
  });

  it("gives the delivery route one answer for every reason to refuse", async () => {
    // The property in full: from outside, a link with the file switched off, a
    // link revoked after being minted with it off, a paper that never had a
    // file, and a token nobody ever minted are the same event. Any difference
    // between them is an oracle — it would publish the existence of a file
    // somebody deliberately did not publish.
    const { ctx, paperId, labId, pi } = await setup();

    const off = (await share(ctx, { paperId, includePdf: false })).token;

    const otherPaper = await ctx.db.insert("papers", {
      labId,
      title: "Revoked",
      addedBy: pi,
      ingestStatus: "ready",
      storageId: "storage_other",
    });
    const revokedOff = (await share(ctx, { paperId: otherPaper })).token;
    const live = (await panel(ctx, { paperId: otherPaper })).share;
    await takeDown(ctx, { shareId: live!._id });

    const bare = await ctx.db.insert("papers", {
      labId,
      title: "No file",
      addedBy: pi,
      ingestStatus: "needs-pdf",
    });
    const neverHad = (await share(ctx, { paperId: bare, includePdf: true }))
      .token;

    const answers = await Promise.all(
      [off, revokedOff, neverHad, "abcdefghijkmnpqrstuvwxyz23", "nope"].map(
        (token) => pdf(ctx, { token }),
      ),
    );

    expect(answers).toEqual([null, null, null, null, null]);
  });

  it("refuses all three at the same step, before anything is spent", async () => {
    // The step matters as much as the answer. `decideSharedPdf` is the route's
    // real order, so driving it here proves *where* the refusal happens rather
    // than only that one happened.
    //
    // Refusing at `lookup` is what makes the three indistinguishable from
    // outside. Nothing downstream runs, so no storage metadata is read and —
    // the part worth pinning — `admit` is never called, which means a withheld
    // link can never write a `shareRateWindows` row. A counter that appeared
    // for an off link and not for a nonexistent token would be an oracle with
    // a database row behind it, readable long after the request. Reordering
    // the sequence so admission came first would keep every assertion in the
    // test above passing and break this one.
    //
    // Division of labour: this test owns the ordering and the side effects.
    // That the bytes and headers of the three refusals are identical on the
    // wire is checked live against a deployment and recorded in the PR — a
    // fake cannot prove anything about what Convex actually puts on the wire.
    const { ctx, paperId, labId, pi } = await setup();

    const off = (await share(ctx, { paperId, includePdf: false })).token;

    const otherPaper = await ctx.db.insert("papers", {
      labId,
      title: "Revoked",
      addedBy: pi,
      ingestStatus: "ready",
      storageId: "storage_other",
    });
    const revokedOn = (
      await share(ctx, { paperId: otherPaper, includePdf: true })
    ).token;
    const live = (await panel(ctx, { paperId: otherPaper })).share;
    await takeDown(ctx, { shareId: live!._id });

    const outcomes = [];
    for (const token of [off, revokedOn, "abcdefghijkmnpqrstuvwxyz23"]) {
      const reached: string[] = [];
      const outcome = await decideSharedPdf(token, {
        lookup: async (t) => {
          reached.push("lookup");
          return await pdf(ctx, { token: t });
        },
        exists: async () => {
          reached.push("exists");
          return true;
        },
        admit: async () => {
          reached.push("admit");
          return "ok";
        },
        download: async () => {
          reached.push("download");
          return "bytes";
        },
      });
      // Stopped at the first question, every time.
      expect(reached).toEqual(["lookup"]);
      outcomes.push(outcome);
    }

    // And stopped with the same answer, so the step and the status agree.
    expect(outcomes).toEqual([{ status: 404 }, { status: 404 }, { status: 404 }]);
    // Nothing was admitted, so nothing was counted: no row exists to read the
    // difference back out of later.
    expect(ctx.db.all("shareRateWindows")).toHaveLength(0);
  });

  it("will not hold a yes for a file that was not there to see", async () => {
    // Consent has to be about an artifact somebody saw. A yes given for a
    // paper with nothing attached must not sit on the row waiting for a file:
    // the URL is already in strangers' hands by then, and a Zotero sync
    // arriving later would make it start serving a document nobody agreed to.
    const { ctx, labId, pi } = await setup();
    const bare = await ctx.db.insert("papers", {
      labId,
      title: "Nothing attached yet",
      addedBy: pi,
      ingestStatus: "needs-pdf",
    });
    const { token } = await share(ctx, { paperId: bare, includePdf: true });

    // The file turns up afterwards.
    await ctx.db.patch(bare, { storageId: "storage_arrived_later" });

    expect(await pdf(ctx, { token })).toBeNull();
    expect(asPaper(await publicView(ctx, { token })).pdf).toBe("withheld");
  });

  it("will not widen a link that is already out there", async () => {
    const { ctx, paperId } = await setup();
    const first = await share(ctx, { paperId });
    // The same press again, this time asking for the file. The link people
    // already hold must not quietly start carrying it.
    const second = await share(ctx, { paperId, includePdf: true });

    expect(second.token).toBe(first.token);
    expect(ctx.db.all("shares")).toHaveLength(1);
    expect(await pdf(ctx, { token: first.token })).toBeNull();
  });

  it("tells the lab which terms its link was minted under", async () => {
    const { ctx, paperId } = await setup();
    await share(ctx, { paperId, includePdf: true });

    const state = await panel(ctx, { paperId });
    expect(state.hasPdf).toBe(true);
    expect(state.share!.includePdf).toBe(true);
  });

  it("says a write-up share carries no file", async () => {
    const { ctx, sessionId } = await setup();
    await ctx.db.patch(sessionId, {
      synthesis: "The lab worked it out.",
      synthesisApprovedAt: Date.now(),
      synthesisCitedAnnotationIds: [],
    });
    await shareWriteUp(ctx, { sessionId });

    expect((await sessionPanel(ctx, { sessionId })).share!.includePdf).toBe(
      false,
    );
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

/* -------------------------------------------------------------------------
 * 8. Rung 0 → rung 1: leaving with the paper
 * ---------------------------------------------------------------------- */

/**
 * `shares.importFromShare` — the only mutation in this codebase whose argument
 * is a capability minted for somebody else's artifact.
 *
 * Its rules, and every one of them is checked below:
 *
 *   1. **The share is re-resolved from scratch, now.** A link revoked, a paper
 *      deleted or a lab gone between the reading and the sign-up imports
 *      nothing, and says nothing.
 *   2. **Metadata always, the file only on the sharer's live consent, the
 *      margin never.** Not a note, not a reply, not an author's name.
 *   3. **Nothing goes back.** The sharing lab gets no row, no event and no
 *      counter — a read report about a stranger is still a read report.
 *   4. **Idempotent.** Twice, or onto a shelf that already holds the paper, is
 *      one row.
 */

const importShare = call<
  { token: string },
  {
    paperId: Id<"papers">;
    labId: Id<"labs">;
    ready: boolean;
    hasPdf: boolean;
  } | null
>(importFromShare);

/**
 * Somebody who has just signed up, with the personal library P1 provisions for
 * them — written out here rather than by calling `labs.ensureMyLibrary`,
 * because that function also seeds a demo paper and this suite is about what
 * the *import* puts on a shelf.
 */
async function visitor(ctx: FakeCtx, name = "Chidi Adeyemi") {
  const userId = await ctx.db.insert("users", { name });
  const labId = await ctx.db.insert("labs", {
    name: `${name}’s library`,
    createdBy: userId,
    memberCount: 1,
    personalFor: userId,
  });
  await ctx.db.insert("memberships", {
    labId,
    userId,
    role: "pi",
    joinedAt: 1,
  });
  return { userId, labId };
}

/** The bytes behind the sharing lab's file, for the copy to actually copy. */
const SHARED_BYTES = "%PDF-1.7 the sharing lab's own upload";

/** The sharing lab's paper, with the citable facts and a real text layer. */
async function publishablePaper(ctx: FakeCtx, paperId: Id<"papers">) {
  await ctx.db.patch(paperId, {
    authors: ["Ana Ruiz", "Ben Okafor"],
    year: 2019,
    venue: "Journal of Reproducibility",
    doi: "10.1000/cold-chain",
    abstract: "An abstract the share page never rendered.",
  });
  ctx.db.putSystem("storage_seed", {
    contentType: "application/pdf",
    size: 200_000,
  });
  ctx.putBlob("storage_seed", new Blob([SHARED_BYTES]));
  for (const [pageIndex, text] of [
    "Samples were incubated at 4°C overnight.",
    "The second cohort diverged.",
  ].entries()) {
    await ctx.db.insert("paperPages", { paperId, pageIndex, text });
  }
}

/** Everything the redeemer's library holds, for counting. */
function shelfOf(ctx: FakeCtx, labId: Id<"labs">) {
  return ctx.db.all("papers").filter((paper) => paper.labId === labId);
}

const copyJob = call<
  { shareId: Id<"shares">; paperId: Id<"papers"> },
  null
>(copySharedPdf);

const COPY_JOB = getFunctionName(internal.shares.copySharedPdf);

/**
 * Run the copy the redemption queued, exactly as the deployment would.
 *
 * The file no longer arrives inside the redemption — a mutation cannot read a
 * blob — so every assertion about a document landing on the redeemer's shelf
 * has to go through the scheduled action, and every assertion about the state
 * *before* it lands simply does not call this.
 *
 * Returns how many jobs it ran, so a test can say that nothing was queued.
 */
async function deliverTheFile(ctx: FakeCtx): Promise<number> {
  ctx
    .register(internal.shares.sharedPdfSource, sharedPdfSource)
    .register(internal.shares.attachImportedPdf, attachImportedPdf);
  const queued = ctx.scheduled.filter((job) => job.name === COPY_JOB);
  for (const job of queued) {
    await copyJob(
      ctx,
      job.args as { shareId: Id<"shares">; paperId: Id<"papers"> },
    );
  }
  ctx.scheduled.length = 0;
  return queued.length;
}

describe("what travels into the redeemer's own library", () => {
  it("carries the citable facts the share page already showed", async () => {
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };
    const outcome = await importShare(ctx, { token });

    const mine = rowAt(shelfOf(ctx, me.labId));
    expect(outcome?.paperId).toBe(mine._id);
    expect(outcome?.labId).toBe(me.labId);
    expect(mine.title).toBe("Cold-chain effects on assay reproducibility");
    expect(mine.authors).toEqual(["Ana Ruiz", "Ben Okafor"]);
    expect(mine.year).toBe(2019);
    expect(mine.venue).toBe("Journal of Reproducibility");
    expect(mine.doi).toBe("10.1000/cold-chain");
    // The paper is the redeemer's, not the sharing lab's: it is on their shelf,
    // added by them, and answers to their library from here on.
    expect(mine.labId).toBe(me.labId);
    expect(mine.addedBy).toBe(me.userId);
    // Nothing the share page did not publish. The abstract is on the sharing
    // lab's row and has never been on a public surface, so it does not travel.
    expect(mine.abstract).toBeUndefined();
  });

  it("never carries the lab's margin — not a note, not a name", async () => {
    const { ctx, pi, member, labId, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    await seedAnnotation(ctx, { labId, paperId, memberId: pi }, {
      body: "The PI's shared note.",
    });
    await seedAnnotation(ctx, { labId, paperId, memberId: member }, {
      body: SECRET,
      visibility: "private",
    });
    const { token } = await share(ctx, { paperId, includePdf: true });

    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };
    await importShare(ctx, { token });

    // The new margin is empty. Not filtered empty — there is no annotation in
    // the redeemer's lab at all, because nothing in the mutation reads the
    // table the lab's writing lives in.
    const carried = ctx.db
      .all("annotations")
      .filter((note) => note.labId === me.labId);
    expect(carried).toEqual([]);
    expect(JSON.stringify(ctx.db.all("papers"))).not.toContain(SECRET);
    expect(JSON.stringify(ctx.db.all("papers"))).not.toContain(
      "The PI's shared note.",
    );
  });

  it("carries the file as bytes of the redeemer's own, never the sharer's blob", async () => {
    const { ctx, labId, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };
    const outcome = await importShare(ctx, { token });
    expect(outcome?.hasPdf).toBe(true);
    expect(await deliverTheFile(ctx)).toBe(1);

    const mine = rowAt(shelfOf(ctx, me.labId));
    // A *copy*, and the identity of the blob is the whole assertion. Claiming
    // the sharer's would be an oracle — a sharer who kept the storage id of a
    // file they have since replaced could ask whether those bytes still exist,
    // and survival answers a question they were never entitled to ask — and it
    // would be permanent, because `papers.blobIsStillClaimed` refuses to delete
    // a blob any paper still points at.
    expect(mine.storageId).toBeDefined();
    expect(mine.storageId).not.toBe("storage_seed");
    expect(ctx.stored).toHaveLength(1);
    expect(await rowAt(ctx.stored).text()).toBe(SHARED_BYTES);
    // And the sharing lab's own row is untouched, still pointing where it did.
    expect(rowAt(shelfOf(ctx, labId)).storageId).toBe("storage_seed");
  });

  it("is file-less until the copy lands, in the state a DOI fetch produces", async () => {
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };
    const outcome = await importShare(ctx, { token });

    // The intervening state, which the reader may well see: exactly what a
    // paper added by DOI with no open-access copy sits in, and which the record
    // page already knows how to finish.
    const mine = rowAt(shelfOf(ctx, me.labId));
    expect(mine.storageId).toBeUndefined();
    expect(mine.ingestStatus).toBe("needs-pdf");
    expect(mine.pageCount).toBeUndefined();
    // `ready` is about the row; `hasPdf` is about where the reader belongs, and
    // a paper whose file is one scheduler hop away belongs on its own record.
    expect(outcome?.ready).toBe(false);
    expect(outcome?.hasPdf).toBe(true);
  });

  it("brings the text layer with the file, and only with the file", async () => {
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };
    await importShare(ctx, { token });
    const mine = rowAt(shelfOf(ctx, me.labId));

    // Nothing before the document arrives. The text layer is pdf.js output over
    // the same bytes, so it is the same disclosure and travels on the same
    // decision — and it would buy nothing on its own, since nothing can be
    // annotated until there is a page on screen to select from.
    expect(
      ctx.db.all("paperPages").filter((page) => page.paperId === mine._id),
    ).toEqual([]);

    await deliverTheFile(ctx);

    const landed = rowAt(shelfOf(ctx, me.labId));
    expect(landed.ingestStatus).toBe("ready");
    expect(landed.pageCount).toBe(2);
    const pages = ctx.db
      .all("paperPages")
      .filter((page) => page.paperId === mine._id)
      .sort((a, b) => a.pageIndex - b.pageIndex);
    expect(pages.map((page) => page.text)).toEqual([
      "Samples were incubated at 4°C overnight.",
      "The second cohort diverged.",
    ]);
  });

  it("leaves the file behind when the sharer kept it back", async () => {
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    // The default: a link that carries the margin and not the document.
    const { token } = await share(ctx, { paperId });

    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };
    const outcome = await importShare(ctx, { token });

    const mine = rowAt(shelfOf(ctx, me.labId));
    expect(mine.storageId).toBeUndefined();
    // `needs-pdf` is the state the DOI ingest already produces and the record
    // page already knows how to finish, so the redeemer fetches it themselves.
    expect(mine.ingestStatus).toBe("needs-pdf");
    expect(mine.pageCount).toBeUndefined();
    expect(outcome).toEqual({
      paperId: mine._id,
      labId: me.labId,
      ready: false,
      hasPdf: false,
    });
    // Nothing queued: there is no file to fetch, so no copy is even attempted.
    expect(await deliverTheFile(ctx)).toBe(0);
    expect(ctx.stored).toEqual([]);
    // And not the text layer either. It is extracted from the file, so it
    // travels with the file or not at all.
    expect(
      ctx.db.all("paperPages").filter((page) => page.paperId === mine._id),
    ).toEqual([]);
  });

  it("lands file-less when the blob has gone missing under the sharer", async () => {
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });
    // The row still claims a file; the deployment no longer holds one.
    await ctx.db.patch(paperId, { storageId: "storage_vanished" });

    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };
    const outcome = await importShare(ctx, { token });

    // Promising a document that is never coming would leave the reader on a
    // record page waiting for a file with nothing on its way.
    expect(rowAt(shelfOf(ctx, me.labId)).storageId).toBeUndefined();
    expect(outcome?.hasPdf).toBe(false);
    expect(await deliverTheFile(ctx)).toBe(0);
  });
});

describe("the file, a moment later", () => {
  /** A redemption that has queued a copy but not run it yet. */
  async function midFlight(includePdf = true) {
    const { ctx, pi, paperId, labId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf });
    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };
    const outcome = await importShare(ctx, { token });
    const live = rowAt(ctx.db.all("shares"));
    return { ctx, pi, me, paperId, labId, token, outcome, shareId: live._id };
  }

  /** The redeemer's row, as it stands. */
  function mineNow(ctx: FakeCtx, labId: Id<"labs">) {
    return rowAt(shelfOf(ctx, labId));
  }

  it("imports no file when the link is revoked between the paper and its bytes", async () => {
    const { ctx, pi, me, shareId } = await midFlight();
    // The sharing lab takes the link down while the copy is still queued.
    ctx.auth = { userId: pi };
    await takeDown(ctx, { shareId });
    ctx.auth = { userId: me.userId };

    await deliverTheFile(ctx);

    // The state a withheld file produces, arrived at by a different road. No
    // error, no half-attached document, and nothing on the redeemer's screen
    // about a lab they have no relationship with.
    const mine = mineNow(ctx, me.labId);
    expect(mine.storageId).toBeUndefined();
    expect(mine.ingestStatus).toBe("needs-pdf");
    expect(
      ctx.db.all("paperPages").filter((page) => page.paperId === mine._id),
    ).toEqual([]);
    // Nothing was even read, so there are no bytes to have leaked.
    expect(ctx.stored).toEqual([]);
  });

  it("discards the copy when the sharer switches the file off mid-flight", async () => {
    const { ctx, me, shareId } = await midFlight();
    // The consent, withdrawn between the two halves of the import.
    await ctx.db.patch(shareId, { includePdf: false });

    await deliverTheFile(ctx);

    expect(mineNow(ctx, me.labId).storageId).toBeUndefined();
    expect(ctx.stored).toEqual([]);
  });

  it("discards the copy when the sharer replaced the file underneath it", async () => {
    const { ctx, me, paperId, shareId } = await midFlight();
    ctx.register(internal.shares.sharedPdfSource, sharedPdfSource);
    ctx.register(internal.shares.attachImportedPdf, attachImportedPdf);

    // The bytes the action read, then a swap, then the attach — the shape of a
    // sharer replacing their PDF inside the window.
    const stale = await ctx.storage.store(new Blob(["stale bytes"]));
    ctx.db.putSystem("storage_new", { contentType: "application/pdf", size: 1 });
    ctx.putBlob("storage_new", new Blob(["a different paper entirely"]));
    await ctx.db.patch(paperId, { storageId: "storage_new" });

    const attach = call<
      {
        shareId: Id<"shares">;
        paperId: Id<"papers">;
        sourceStorageId: Id<"_storage">;
        storageId: Id<"_storage">;
      },
      "attached" | "declined"
    >(attachImportedPdf);
    const outcome = await attach(ctx, {
      shareId,
      paperId: mineNow(ctx, me.labId)._id,
      sourceStorageId: "storage_seed" as Id<"_storage">,
      storageId: stale,
    });

    // Consent now covers a different document. Attaching the old one would be
    // handing over a file under a permission given for another.
    expect(outcome).toBe("declined");
    expect(mineNow(ctx, me.labId).storageId).toBeUndefined();
    expect(ctx.discarded).toContain(stale);
  });

  it("discards the copy when the redeemer's own paper is gone", async () => {
    const { ctx, me } = await midFlight();
    await ctx.db.delete(mineNow(ctx, me.labId)._id);

    await deliverTheFile(ctx);

    // Stored, then found nowhere to go, then deleted — rather than left in the
    // deployment with nothing pointing at it.
    expect(ctx.stored).toHaveLength(1);
    expect(ctx.discarded).toHaveLength(1);
    expect(shelfOf(ctx, me.labId)).toEqual([]);
  });

  it("attaches once, and refuses to attach over a file already there", async () => {
    const { ctx, me, shareId } = await midFlight();
    await deliverTheFile(ctx);
    const first = mineNow(ctx, me.labId).storageId;
    expect(first).toBeDefined();

    ctx.register(internal.shares.sharedPdfSource, sharedPdfSource);
    ctx.register(internal.shares.attachImportedPdf, attachImportedPdf);
    const second = await ctx.storage.store(new Blob(["a second copy"]));
    const attach = call<
      {
        shareId: Id<"shares">;
        paperId: Id<"papers">;
        sourceStorageId: Id<"_storage">;
        storageId: Id<"_storage">;
      },
      "attached" | "declined"
    >(attachImportedPdf);

    expect(
      await attach(ctx, {
        shareId,
        paperId: mineNow(ctx, me.labId)._id,
        sourceStorageId: "storage_seed" as Id<"_storage">,
        storageId: second,
      }),
    ).toBe("declined");
    expect(mineNow(ctx, me.labId).storageId).toBe(first);
    expect(ctx.discarded).toContain(second);
    // And no second text layer stacked on the first.
    expect(
      ctx.db
        .all("paperPages")
        .filter((page) => page.paperId === mineNow(ctx, me.labId)._id),
    ).toHaveLength(2);
  });

  it("discards the copy when the attach itself fails, and re-raises", async () => {
    // The committed delete inside the mutation covers every ordinary refusal —
    // but it cannot cover the mutation failing, because a transaction that
    // throws leaves nothing behind, including its own delete. Without the
    // action cleaning up after itself, those bytes would sit in the deployment
    // forever with no row and no query able to reach them.
    const { ctx } = await midFlight();
    ctx.register(internal.shares.sharedPdfSource, sharedPdfSource);
    ctx.register(internal.shares.attachImportedPdf, {
      _handler: () => {
        throw new Error("the attach fell over");
      },
    });

    const job = rowAt(ctx.scheduled.filter((each) => each.name === COPY_JOB));
    await expect(
      copyJob(ctx, job.args as { shareId: Id<"shares">; paperId: Id<"papers"> }),
    ).rejects.toThrow("the attach fell over");

    // Stored once, discarded once — and the failure surfaced rather than being
    // swallowed, so the scheduler records it as the fault it is.
    expect(ctx.stored).toHaveLength(1);
    expect(ctx.discarded).toHaveLength(1);
  });

  it("says nothing to the sharing lab about any of it", async () => {
    const { ctx, labId } = await midFlight();
    const before = ctx.db.all("events").filter((e) => e.labId === labId).length;
    await deliverTheFile(ctx);
    expect(
      ctx.db.all("events").filter((e) => e.labId === labId).length,
    ).toBe(before);
  });
});

describe("a link that stopped being a link", () => {
  it("imports nothing once the share is revoked, and says nothing", async () => {
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });
    const live = rowAt(ctx.db.all("shares"));
    await takeDown(ctx, { shareId: live._id });

    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };

    // `null`, not a throw. There is no version of "that lab withdrew this while
    // you were signing up" worth putting on the first screen of an account.
    await expect(importShare(ctx, { token })).resolves.toBeNull();
    expect(shelfOf(ctx, me.labId)).toEqual([]);
  });

  it("imports nothing when the paper was deleted under it", async () => {
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });
    await ctx.db.delete(paperId);

    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };
    expect(await importShare(ctx, { token })).toBeNull();
    expect(shelfOf(ctx, me.labId)).toEqual([]);
  });

  it("imports nothing when the sharing lab is gone", async () => {
    const { ctx, labId, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });
    await ctx.db.delete(labId);

    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };
    // Nobody is left to have consented to this being public.
    expect(await importShare(ctx, { token })).toBeNull();
  });

  it("imports nothing for a token that was never minted, or is not one", async () => {
    const { ctx } = await setup();
    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };

    for (const token of ["", "nope", "a".repeat(26), "../../../etc/passwd"]) {
      expect(await importShare(ctx, { token }), token).toBeNull();
    }
    expect(shelfOf(ctx, me.labId)).toEqual([]);
  });

  it("imports nothing from a write-up's link", async () => {
    // A synthesis share names a session, not a paper. Its token opens a page of
    // prose the lab signed off; there is no artifact behind it to put on a
    // shelf, and reaching through it to the session's paper would be importing
    // something nobody shared.
    const { ctx, sessionId, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    await ctx.db.patch(sessionId, {
      synthesis: "What we worked out.",
      synthesisApprovedAt: 10,
      synthesisCitedAnnotationIds: [],
    });
    const { token } = await shareWriteUp(ctx, { sessionId });

    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };
    expect(await importShare(ctx, { token })).toBeNull();
    expect(shelfOf(ctx, me.labId)).toEqual([]);
  });
});

describe("the sharing lab learns nothing", () => {
  it("writes no row and no event anywhere but the redeemer's own library", async () => {
    const { ctx, labId, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    const before = ctx.db
      .all("events")
      .filter((event) => event.labId === labId).length;

    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };
    await importShare(ctx, { token });

    // Not one row. "Somebody imported your paper" is a read report about a
    // stranger who agreed to nothing, and the ban on read tracking on public
    // surfaces does not soften because the read ended in a signup.
    expect(
      ctx.db.all("events").filter((event) => event.labId === labId).length,
    ).toBe(before);
    expect(shelfOf(ctx, labId)).toHaveLength(1);
    // Nor is the redeemer's name written into the sharing lab's consent rows.
    expect(
      ctx.db
        .all("paperShareOptIns")
        .filter((row) => row.userId === me.userId),
    ).toEqual([]);
  });

  it("files the arrival in the redeemer's own ledger, in the ordinary words", async () => {
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };
    await importShare(ctx, { token });

    const filed = ctx.db.all("events").filter((e) => e.labId === me.labId);
    expect(filed).toHaveLength(1);
    const arrival = rowAt(filed);
    // `paper.added` rather than a new event type. The ledger already has a word
    // for a paper arriving on a shelf, and a second one would be a fact the
    // product then has to decide who may read.
    expect(arrival.type).toBe("paper.added");
    expect(arrival.actorId).toBe(me.userId);
    // And no share token in it: `events` rows are never deleted, so a token
    // written into one would outlive every revocation.
    expect(JSON.stringify(filed)).not.toContain(token);
  });
});

describe("redeeming more than once", () => {
  it("hands back the same paper the second time", async () => {
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };
    const first = await importShare(ctx, { token });
    await deliverTheFile(ctx);
    const second = await importShare(ctx, { token });

    expect(second?.paperId).toBe(first?.paperId);
    expect(shelfOf(ctx, me.labId)).toHaveLength(1);
    // The second answer describes the row as it now stands rather than as the
    // first redemption left it: the file has landed, so the reader who presses
    // the link again goes straight to the paper.
    expect(second).toEqual({
      paperId: first?.paperId,
      labId: me.labId,
      ready: true,
      hasPdf: true,
    });
    // One copy of the bytes, not two.
    expect(ctx.stored).toHaveLength(1);
  });

  it("does not queue a second copy for a paper it already recognised", async () => {
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };
    await importShare(ctx, { token });
    await deliverTheFile(ctx);
    await importShare(ctx, { token });

    expect(await deliverTheFile(ctx)).toBe(0);
    expect(ctx.stored).toHaveLength(1);
  });

  it("recognises a paper already on the shelf by its DOI", async () => {
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    const me = await visitor(ctx);
    const already = await ctx.db.insert("papers", {
      labId: me.labId,
      title: "The same paper, filed under a title of my own",
      doi: "10.1000/cold-chain",
      ingestStatus: "needs-pdf",
      addedBy: me.userId,
    });

    ctx.auth = { userId: me.userId };
    expect((await importShare(ctx, { token }))?.paperId).toBe(already);
    expect(shelfOf(ctx, me.labId)).toHaveLength(1);
  });

  it("recognises one by its file when there is no DOI to go on", async () => {
    // A preprint shared with no DOI has nothing else to be recognised by — and
    // an imported copy points at the *same* blob as the paper it came from, so
    // this is the one dedupe key that is provably about the same document.
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    await ctx.db.patch(paperId, { doi: undefined });
    const { token } = await share(ctx, { paperId, includePdf: true });

    const me = await visitor(ctx);
    const already = await ctx.db.insert("papers", {
      labId: me.labId,
      title: "A title nothing would match on",
      storageId: "storage_seed",
      ingestStatus: "ready",
      addedBy: me.userId,
    });

    ctx.auth = { userId: me.userId };
    expect((await importShare(ctx, { token }))?.paperId).toBe(already);
    expect(shelfOf(ctx, me.labId)).toHaveLength(1);
  });

  it("keeps two papers apart when their DOIs prove them distinct", async () => {
    // Title-and-year is the last resort, and it never overrules a DOI. Two rows
    // that both carry one and carry different ones are two different papers
    // however alike their titles read — that is what a DOI is *for* — and
    // merging them would lose one behind the other with nothing to show for it.
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId });

    const me = await visitor(ctx);
    const other = await ctx.db.insert("papers", {
      labId: me.labId,
      title: "Cold-chain effects on assay reproducibility",
      year: 2019,
      doi: "10.1000/a-different-paper",
      ingestStatus: "needs-pdf",
      addedBy: me.userId,
    });

    ctx.auth = { userId: me.userId };
    const outcome = await importShare(ctx, { token });
    expect(outcome?.paperId).not.toBe(other);
    expect(shelfOf(ctx, me.labId)).toHaveLength(2);
  });

  it("does not fold a paper with a DOI into a row that has none", async () => {
    // Title and year decide nothing unless *neither* row has a DOI. A shelf row
    // filed by hand under the same normalized title and year is not evidence of
    // the same paper — "Editorial 2019" collides with "Editorial 2019" — and
    // folding into it would hand the reader back the wrong row while the paper
    // they actually asked for, and its file, never arrived and never said so.
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    const me = await visitor(ctx);
    const unrelated = await ctx.db.insert("papers", {
      labId: me.labId,
      title: "Cold-Chain Effects on Assay Reproducibility",
      year: 2019,
      ingestStatus: "needs-pdf",
      addedBy: me.userId,
    });

    ctx.auth = { userId: me.userId };
    const outcome = await importShare(ctx, { token });
    expect(outcome?.paperId).not.toBe(unrelated);
    expect(shelfOf(ctx, me.labId)).toHaveLength(2);

    // And the shared paper really did arrive whole, which is the half of this
    // that a wrong merge takes away silently.
    await deliverTheFile(ctx);
    const mine = await ctx.db.get(outcome!.paperId);
    expect(mine?.doi).toBe("10.1000/cold-chain");
    expect(mine?.storageId).toBeDefined();
  });

  it("does not fold a DOI-less share into a shelf row that has one", async () => {
    // The same rule read from the other side, so neither direction can drift.
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    await ctx.db.patch(paperId, { doi: undefined });
    const { token } = await share(ctx, { paperId });

    const me = await visitor(ctx);
    const unrelated = await ctx.db.insert("papers", {
      labId: me.labId,
      title: "Cold-Chain Effects on Assay Reproducibility",
      year: 2019,
      doi: "10.1000/somebody-elses-record",
      ingestStatus: "needs-pdf",
      addedBy: me.userId,
    });

    ctx.auth = { userId: me.userId };
    expect((await importShare(ctx, { token }))?.paperId).not.toBe(unrelated);
    expect(shelfOf(ctx, me.labId)).toHaveLength(2);
  });

  it("reads the newest of a long shelf, where a fresh import actually is", async () => {
    // The last pass is bounded, so which end it reads decides whether a second
    // press of the same link finds the row the first press wrote. On a shelf
    // longer than the bound, the oldest rows are the ones least likely to be
    // the paper in question — and the import, being minutes old, is the newest
    // thing there.
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    await ctx.db.patch(paperId, { doi: undefined });
    const { token } = await share(ctx, { paperId });

    const me = await visitor(ctx);
    for (let index = 0; index < 200; index += 1) {
      await ctx.db.insert("papers", {
        labId: me.labId,
        title: `Filler ${index}`,
        ingestStatus: "needs-pdf",
        addedBy: me.userId,
      });
    }

    ctx.auth = { userId: me.userId };
    const first = await importShare(ctx, { token });
    const second = await importShare(ctx, { token });

    expect(second?.paperId).toBe(first?.paperId);
    expect(shelfOf(ctx, me.labId)).toHaveLength(201);
  });

  it("recognises one by title and year when it has neither", async () => {
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    await ctx.db.patch(paperId, { doi: undefined });
    const { token } = await share(ctx, { paperId });

    const me = await visitor(ctx);
    const already = await ctx.db.insert("papers", {
      labId: me.labId,
      title: "Cold-Chain Effects on Assay Reproducibility",
      year: 2019,
      ingestStatus: "needs-pdf",
      addedBy: me.userId,
    });

    ctx.auth = { userId: me.userId };
    expect((await importShare(ctx, { token }))?.paperId).toBe(already);
    expect(shelfOf(ctx, me.labId)).toHaveLength(1);
  });

  it("does not mistake somebody else's copy for one of mine", async () => {
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    const me = await visitor(ctx);
    const you = await visitor(ctx, "Dara Ito");
    ctx.auth = { userId: you.userId };
    await importShare(ctx, { token });

    ctx.auth = { userId: me.userId };
    await importShare(ctx, { token });

    // Two libraries, one paper each, and neither read the other's shelf.
    expect(shelfOf(ctx, me.labId)).toHaveLength(1);
    expect(shelfOf(ctx, you.labId)).toHaveLength(1);
  });
});

describe("how often anyone may redeem", () => {
  /** A library that has just been filled, as a script would fill one. */
  async function fillShelf(ctx: FakeCtx, me: { userId: string; labId: string }, count: number) {
    for (let index = 0; index < count; index += 1) {
      const id = await ctx.db.insert("papers", {
        labId: me.labId as Id<"labs">,
        title: `Filler ${index}`,
        ingestStatus: "needs-pdf",
        addedBy: me.userId as Id<"users">,
      });
      // The fixture stamps rows with a counter rather than a clock, so the
      // window has to be put where the mutation will look for it.
      await ctx.db.patch(id, { _creationTime: Date.now() });
    }
  }

  it("stops opening the door once a library has gained two hundred in an hour", async () => {
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    const me = await visitor(ctx);
    // Exactly the ceiling, not one past it: two hundred inside the window means
    // the allowance is spent, and the two hundred and first is the one refused.
    await fillShelf(ctx, me, 200);
    ctx.auth = { userId: me.userId };

    // The same `null` every other refusal gives, so it is indistinguishable
    // from a revoked link and says nothing about why.
    expect(await importShare(ctx, { token })).toBeNull();
    expect(shelfOf(ctx, me.labId)).toHaveLength(200);
    expect(await deliverTheFile(ctx)).toBe(0);
  });

  it("still opens it one short of the ceiling", async () => {
    // The other side of the boundary, so the count cannot quietly drift by one
    // in either direction.
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    const me = await visitor(ctx);
    await fillShelf(ctx, me, 199);
    ctx.auth = { userId: me.userId };

    expect(await importShare(ctx, { token })).not.toBeNull();
    expect(shelfOf(ctx, me.labId)).toHaveLength(200);
  });

  it("lets a second press of the same link through a spent hour", async () => {
    // The ceiling gates new rows. A redemption that finds the paper already on
    // the shelf writes nothing at all, and refusing it would spend a token the
    // reader's browser has already let go of in order to protect the
    // deployment from a mutation that inserts nothing.
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    const me = await visitor(ctx);
    ctx.auth = { userId: me.userId };
    const first = await importShare(ctx, { token });
    await deliverTheFile(ctx);
    await fillShelf(ctx, me, 200);
    // The import counts towards the hour too — it is a paper the library
    // gained — so the whole shelf is inside the window and the ceiling is
    // genuinely spent when the second press arrives.
    await ctx.db.patch(first!.paperId, { _creationTime: Date.now() });

    const again = await importShare(ctx, { token });
    expect(again?.paperId).toBe(first?.paperId);
    expect(shelfOf(ctx, me.labId)).toHaveLength(201);
  });

  it("counts the hour, not the shelf", async () => {
    // A researcher with a large library is not a script. What is being bounded
    // is how fast one arrived, not how much of it there is.
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    const me = await visitor(ctx);
    await fillShelf(ctx, me, 201);
    for (const paper of shelfOf(ctx, me.labId)) {
      await ctx.db.patch(paper._id, {
        _creationTime: Date.now() - 2 * 60 * 60 * 1000,
      });
    }
    ctx.auth = { userId: me.userId };

    expect(await importShare(ctx, { token })).not.toBeNull();
    expect(shelfOf(ctx, me.labId)).toHaveLength(202);
  });

  it("is a fact about the caller's own shelf and nobody else's", async () => {
    // Keyed by the redeemer's library rather than by the link, which is the
    // opposite of every other guard on this module — and deliberately so. A
    // counter keyed by the share would be a count of how many strangers took a
    // lab's paper, which is the read report P7 refuses to keep.
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    const me = await visitor(ctx);
    const you = await visitor(ctx, "Dara Ito");
    await fillShelf(ctx, me, 201);

    ctx.auth = { userId: me.userId };
    expect(await importShare(ctx, { token })).toBeNull();
    ctx.auth = { userId: you.userId };
    expect(await importShare(ctx, { token })).not.toBeNull();
  });
});

describe("who may redeem", () => {
  it("refuses somebody with no session at all", async () => {
    const { ctx, paperId } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    ctx.auth = {};
    await expect(importShare(ctx, { token })).rejects.toThrow(ConvexError);
  });

  it("writes nothing for an account with no personal library", async () => {
    // Somebody who was in a lab before P1 shipped has no library of their own,
    // and the honest answer is to do nothing: dropping a stranger's paper into
    // a research group's shelf on the strength of a link one member clicked is
    // a write into other people's library that nobody asked for.
    const { ctx, paperId, labId, member } = await setup();
    await publishablePaper(ctx, paperId);
    const { token } = await share(ctx, { paperId, includePdf: true });

    ctx.auth = { userId: member };
    expect(await importShare(ctx, { token })).toBeNull();
    expect(shelfOf(ctx, labId)).toHaveLength(1);
  });
});
