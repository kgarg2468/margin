import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireMembership, requireUserId } from "./lib/authz";
import { recordEvent } from "./lib/ledger";
import { ingestStatus } from "./schema";
import { normalizeTags } from "../lib/library/tags";

/**
 * How a lab arranges its shelf: collections, and the saved views a member
 * keeps over it.
 *
 * The two live in one module because they are the same act seen from two
 * sides, and they differ on exactly one axis — who owns the arrangement. A
 * collection is lab property: anybody can make one, anybody can put a paper in
 * it, and the ledger records every one of those as a fact about the lab. A
 * saved filter is a working note about one person's week; nobody else can see
 * it and nothing about it reaches the ledger.
 *
 * That asymmetry is the design, not an oversight. See `convex/schema.ts` for
 * why saved filters are deliberately outside the provenance record.
 */

/** The library's own `take(200)`: a collection can hold every paper a lab can list. */
const MAX_COLLECTION_PAPERS = 200;

/** A shelf you cannot see the end of is not a shelf. */
const MAX_COLLECTIONS_PER_LAB = 60;

/** Enough for "Methods week (revisited)", short of a description. */
const MAX_NAME_LENGTH = 60;

/**
 * Saved views are personal, so this cap is about the one member's sidebar
 * rather than about storage. Past a dozen or so, finding the saved filter costs
 * more than rebuilding it.
 */
const MAX_SAVED_FILTERS = 20;

const collectionSummary = v.object({
  _id: v.id("collections"),
  name: v.string(),
  paperIds: v.array(v.id("papers")),
  paperCount: v.number(),
  createdAt: v.number(),
  createdByName: v.optional(v.string()),
  /** Whether the caller may rename or delete it — the creator, or the PI. */
  canManage: v.boolean(),
});

const savedFilterSummary = v.object({
  _id: v.id("savedFilters"),
  name: v.string(),
  tags: v.array(v.string()),
  collectionId: v.optional(v.id("collections")),
  ingestStatus: v.optional(ingestStatus),
});

function cleanName(input: string): string {
  const name = input.trim().replace(/\s+/g, " ");
  if (name.length === 0) {
    throw new ConvexError("Give it a name — that is the whole point of one.");
  }
  return name.slice(0, MAX_NAME_LENGTH);
}

/**
 * A collection the caller is allowed to touch, plus the membership that allowed
 * it — same shape, and the same reasoning, as `requirePaperAccess` in
 * `convex/papers.ts`: the caller almost always needs the `userId` to attribute
 * a ledger event, and resolving it twice is a second index read for nothing.
 */
async function requireCollectionAccess(
  ctx: QueryCtx | MutationCtx,
  collectionId: Id<"collections">,
): Promise<{
  collection: Doc<"collections">;
  membership: Doc<"memberships">;
}> {
  const collection = await ctx.db.get(collectionId);
  if (collection === null) {
    throw new ConvexError("That collection is no longer in the library.");
  }
  const membership = await requireMembership(ctx, collection.labId);
  return { collection, membership };
}

/**
 * Renaming and deleting are narrower than making and filling.
 *
 * Any member may create a collection and put papers in it, because that is
 * additive — the worst case is a shelf somebody else ignores. Renaming and
 * deleting take something away from everyone who was using it, so they stay
 * with the person who made it and the PI, who is the one person accountable for
 * the lab's shelves either way.
 */
function canManage(
  collection: Doc<"collections">,
  membership: Doc<"memberships">,
): boolean {
  return (
    collection.createdBy === membership.userId || membership.role === "pi"
  );
}

/* ------------------------------------------------------------ shelves --- */

/** Every collection in the lab, oldest first — the order they were made in is the order they are read in. */
export const listCollections = query({
  args: { labId: v.id("labs") },
  returns: v.array(collectionSummary),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);

    const collections = await ctx.db
      .query("collections")
      .withIndex("by_lab", (q) => q.eq("labId", args.labId))
      .take(MAX_COLLECTIONS_PER_LAB);

    // One read per distinct creator rather than per collection: a lab's
    // collections are made by a handful of people, and most of these ids
    // repeat.
    const names = new Map<Id<"users">, string | undefined>();
    for (const collection of collections) {
      if (!names.has(collection.createdBy)) {
        const user = await ctx.db.get(collection.createdBy);
        names.set(collection.createdBy, user?.name ?? user?.email);
      }
    }

    return collections.map((collection) => ({
      _id: collection._id,
      name: collection.name,
      paperIds: collection.paperIds,
      paperCount: collection.paperIds.length,
      createdAt: collection._creationTime,
      createdByName: names.get(collection.createdBy),
      canManage: canManage(collection, membership),
    }));
  },
});

export const createCollection = mutation({
  args: { labId: v.id("labs"), name: v.string() },
  returns: v.id("collections"),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);
    const name = cleanName(args.name);

    const existing = await ctx.db
      .query("collections")
      .withIndex("by_lab", (q) => q.eq("labId", args.labId))
      .collect();
    if (existing.length >= MAX_COLLECTIONS_PER_LAB) {
      throw new ConvexError(
        `This lab already has ${MAX_COLLECTIONS_PER_LAB} collections. Delete one before making another.`,
      );
    }
    // Names are how members refer to these out loud, so two shelves called
    // "Methods week" is a conversation nobody can have. Compared case-blind
    // for the same reason tags are.
    if (
      existing.some(
        (collection) => collection.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new ConvexError(`This lab already has a collection called “${name}”.`);
    }

    const collectionId = await ctx.db.insert("collections", {
      labId: args.labId,
      name,
      createdBy: membership.userId,
      paperIds: [],
    });

    await recordEvent(ctx, {
      labId: args.labId,
      type: "collection.created",
      actorId: membership.userId,
      collectionId,
      name,
    });

    return collectionId;
  },
});

export const renameCollection = mutation({
  args: { collectionId: v.id("collections"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { collection, membership } = await requireCollectionAccess(
      ctx,
      args.collectionId,
    );
    if (!canManage(collection, membership)) {
      throw new ConvexError(
        "Only the member who made this collection, or the lab's PI, can rename it.",
      );
    }

    const name = cleanName(args.name);
    if (name === collection.name) {
      // Not an error, but not a fact either: a ledger row saying a collection
      // was renamed to what it was already called is noise in the record.
      return null;
    }

    await ctx.db.patch(collection._id, { name });
    await recordEvent(ctx, {
      labId: collection.labId,
      type: "collection.renamed",
      actorId: membership.userId,
      collectionId: collection._id,
      name,
    });
    return null;
  },
});

/**
 * Delete the shelf, not the papers on it.
 *
 * A collection holds ids; the papers are in the library and stay there. What
 * this does leave behind is other members' saved filters pointing at an id that
 * no longer resolves — deliberately, and see the schema for why: cascading into
 * a colleague's saved views would be one member quietly editing another's
 * furniture. The library says the shelf is gone and the filter is one click
 * from being cleared.
 */
export const deleteCollection = mutation({
  args: { collectionId: v.id("collections") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { collection, membership } = await requireCollectionAccess(
      ctx,
      args.collectionId,
    );
    if (!canManage(collection, membership)) {
      throw new ConvexError(
        "Only the member who made this collection, or the lab's PI, can delete it.",
      );
    }

    await ctx.db.delete(collection._id);
    await recordEvent(ctx, {
      labId: collection.labId,
      type: "collection.deleted",
      actorId: membership.userId,
      collectionId: collection._id,
      name: collection.name,
    });
    return null;
  },
});

/**
 * Put a paper on a shelf, or take it off.
 *
 * One paper at a time and idempotent in both directions: adding a paper that is
 * already there and removing one that never was both succeed silently and write
 * nothing to the ledger. The library's checkboxes fire on every click, and a
 * provenance record that grows a row each time somebody double-clicks is a
 * record nobody will read.
 *
 * A paper appended goes to the end. That is the ordering, and it is the one the
 * product promises in v1 — a collection is the order the lab built it in.
 */
export const setPaperInCollection = mutation({
  args: {
    collectionId: v.id("collections"),
    paperId: v.id("papers"),
    inCollection: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { collection, membership } = await requireCollectionAccess(
      ctx,
      args.collectionId,
    );

    const paper = await ctx.db.get(args.paperId);
    // Same lab, checked against the collection rather than the caller's claim:
    // membership in the lab this collection belongs to says nothing about a
    // paper id that came from somewhere else entirely.
    if (paper === null || paper.labId !== collection.labId) {
      throw new ConvexError("That paper isn't in this lab's library.");
    }

    const present = collection.paperIds.includes(args.paperId);
    if (present === args.inCollection) {
      return null;
    }

    if (args.inCollection && collection.paperIds.length >= MAX_COLLECTION_PAPERS) {
      throw new ConvexError(
        `A collection holds up to ${MAX_COLLECTION_PAPERS} papers, and “${collection.name}” is full.`,
      );
    }

    await ctx.db.patch(collection._id, {
      paperIds: args.inCollection
        ? [...collection.paperIds, args.paperId]
        : collection.paperIds.filter((id) => id !== args.paperId),
    });

    await recordEvent(ctx, {
      labId: collection.labId,
      type: "collection.papers_changed",
      actorId: membership.userId,
      collectionId: collection._id,
      paperId: args.paperId,
      change: args.inCollection ? "added" : "removed",
    });
    return null;
  },
});

/* ------------------------------------------------------- saved filters --- */

/**
 * The caller's own saved views for this lab. Nobody else's, ever: the query is
 * keyed on the signed-in user, so there is no argument a member could pass to
 * see a colleague's.
 */
export const listSavedFilters = query({
  args: { labId: v.id("labs") },
  returns: v.array(savedFilterSummary),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);

    const saved = await ctx.db
      .query("savedFilters")
      .withIndex("by_user_and_lab", (q) =>
        q.eq("userId", membership.userId).eq("labId", args.labId),
      )
      .take(MAX_SAVED_FILTERS);

    return saved.map((filter) => ({
      _id: filter._id,
      name: filter.name,
      tags: filter.tags,
      collectionId: filter.collectionId,
      ingestStatus: filter.ingestStatus,
    }));
  },
});

/**
 * Keep the current view under a name.
 *
 * Re-saving a name overwrites it rather than making a second one. A member who
 * types "Thursday" twice means "this is what Thursday looks like now" — two
 * rows with one name would be a list they cannot tell apart.
 */
export const saveFilter = mutation({
  args: {
    labId: v.id("labs"),
    name: v.string(),
    tags: v.array(v.string()),
    collectionId: v.optional(v.id("collections")),
    ingestStatus: v.optional(ingestStatus),
  },
  returns: v.id("savedFilters"),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);
    const name = cleanName(args.name);
    // The same normalization the client filters with. A saved filter holding
    // "Methods " would quietly match nothing at all.
    const tags = normalizeTags(args.tags);

    if (args.collectionId !== undefined) {
      const collection = await ctx.db.get(args.collectionId);
      if (collection === null || collection.labId !== args.labId) {
        throw new ConvexError("That collection isn't in this lab.");
      }
    }

    const existing = await ctx.db
      .query("savedFilters")
      .withIndex("by_user_and_lab", (q) =>
        q.eq("userId", membership.userId).eq("labId", args.labId),
      )
      .collect();

    const sameName = existing.find(
      (filter) => filter.name.toLowerCase() === name.toLowerCase(),
    );
    if (sameName !== undefined) {
      await ctx.db.patch(sameName._id, {
        name,
        tags,
        collectionId: args.collectionId,
        ingestStatus: args.ingestStatus,
      });
      return sameName._id;
    }

    if (existing.length >= MAX_SAVED_FILTERS) {
      throw new ConvexError(
        `You have ${MAX_SAVED_FILTERS} saved filters in this lab. Delete one before saving another.`,
      );
    }

    return await ctx.db.insert("savedFilters", {
      userId: membership.userId,
      labId: args.labId,
      name,
      tags,
      collectionId: args.collectionId,
      ingestStatus: args.ingestStatus,
    });
  },
});

export const deleteSavedFilter = mutation({
  args: { savedFilterId: v.id("savedFilters") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const saved = await ctx.db.get(args.savedFilterId);
    if (saved === null) {
      return null;
    }
    // Ownership, not membership: this row belongs to a person, and being in the
    // same lab is not a claim on it.
    if (saved.userId !== userId) {
      throw new ConvexError("That saved filter belongs to somebody else.");
    }
    await ctx.db.delete(saved._id);
    return null;
  },
});
