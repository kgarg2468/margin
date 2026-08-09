import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireMembership } from "./lib/authz";
import { MAX_NOTES_LENGTH, cleanTitle } from "./sessions";

/**
 * The meeting shapes a lab keeps: an agenda saved once and applied to the
 * sessions that come after it.
 *
 * A lab that runs the same journal club every week already knows what the
 * agenda is — fifteen minutes of background, the figure everyone argues about,
 * what we would do differently — and types it into the presenter notes of
 * every session until somebody stops bothering. That is the entire feature.
 * There is no new agenda machinery here: a template holds the two fields a
 * session already has (`title`, `presenterNotes`), and applying one at
 * scheduling time copies them across (see `createSession`).
 *
 * ## Who may do what
 *
 * Any member may save one; whoever saved it, or the PI, may edit or delete it.
 * That is `collections.ts`'s rule, arrived at the same way and for the same
 * reason. Any member can already put a session on the calendar — the product
 * refuses to make the PI a bottleneck for clerical work, and the rotating
 * organiser scheduling a term of meetings is exactly the person who types the
 * same agenda six times. Restricting saving to the PI would lock the feature
 * away from the one person it is for.
 *
 * Editing is narrower because a template is lab-visible: it sits in the picker
 * of everyone who schedules anything, so changing one is changing what the lab
 * sees, and deleting one takes it away from people who were using it. Those
 * stay with the author and with the PI, who answers for how the lab runs its
 * meetings either way.
 *
 * ## Not in the ledger
 *
 * `events` records what the lab did — a session held, a paper added, a note
 * withdrawn. A template is stationery. The session it produces is already
 * recorded by `session.scheduled`, with its own copy of the agenda, so nothing
 * about the lab's account of its work is missing. Saving a form is not a fact
 * about a lab, and a ledger that filled up with them would be a worse record
 * of the ones that are.
 */

/**
 * How many shapes a lab may keep.
 *
 * A lab runs a handful of kinds of meeting — the ordinary paper, methods week,
 * a preprint triage, a visitor. Twelve is already more than any of them has,
 * and it is the ceiling the *picker* wants rather than the storage: past a
 * dozen a select stops being a list you scan and becomes one you would want to
 * search, and a lab that needs search over its meeting shapes has stopped
 * saving shapes and started keeping notes in the wrong place.
 */
const MAX_TEMPLATES_PER_LAB = 12;

/** `collections.ts`'s ceiling, and for the same reason: enough for "Methods week (short)", short of a description. */
const MAX_NAME_LENGTH = 60;

/**
 * A template is a shape, not a manuscript.
 *
 * Deliberately far under a session's own `MAX_NOTES_LENGTH` of 20,000, which
 * is sized for a presenter's full prep on one particular paper. What gets
 * saved here is the part that is true every week, and a shape that runs to
 * four thousand characters is a presenter's notes about a paper that has been
 * filed as though it were about all of them. The gap also means applying a
 * template can never produce notes the session would refuse.
 */
const MAX_TEMPLATE_NOTES_LENGTH = 4_000;

const templateSummary = v.object({
  _id: v.id("sessionTemplates"),
  name: v.string(),
  title: v.optional(v.string()),
  presenterNotes: v.string(),
  createdByName: v.optional(v.string()),
  /** Whether the caller may edit or delete it — the member who saved it, or the PI. */
  canManage: v.boolean(),
});

/* -------------------------------------------------------------------------
 * Rules
 * ---------------------------------------------------------------------- */

/** Exported for tests: a template with no name is a row nobody can point at. */
export function cleanTemplateName(input: string): string {
  const name = input.trim().replace(/\s+/g, " ");
  if (name.length === 0) {
    throw new ConvexError("Give the shape a name — that is how you find it.");
  }
  return name.slice(0, MAX_NAME_LENGTH);
}

/**
 * The agenda itself. Line breaks survive — it is an outline — and too long is
 * refused rather than trimmed, which is `cleanNotes`'s reasoning in
 * `sessions.ts`: a silent `slice` tells someone their template saved and lets
 * them discover the missing half at a meeting.
 *
 * Exported for tests.
 */
export function cleanTemplateNotes(input: string): string {
  const notes = input.trim();
  if (notes.length === 0) {
    throw new ConvexError(
      "An empty template has nothing to apply. Write the agenda you would otherwise retype.",
    );
  }
  if (notes.length > MAX_TEMPLATE_NOTES_LENGTH) {
    throw new ConvexError(
      `That agenda is ${notes.length} characters. A template stops at ${MAX_TEMPLATE_NOTES_LENGTH} — it is the shape of a meeting, not one meeting's prep. Presenter notes on the session itself go to ${MAX_NOTES_LENGTH}.`,
    );
  }
  return notes;
}

/**
 * A template's name is unique within its lab, compared case-blind — the rule
 * `collections.ts` holds shelves to, for the reason it gives: two entries the
 * picker draws identically is a choice nobody can make.
 *
 * Takes the lab's templates rather than reading them, since both callers are
 * already holding the list. `exclude` is the one being edited, which is
 * allowed to keep its own name.
 *
 * Exported for tests.
 */
export function requireNameFree(
  templates: readonly Doc<"sessionTemplates">[],
  name: string,
  exclude?: Id<"sessionTemplates">,
): void {
  const taken = templates.some(
    (template) =>
      template._id !== exclude &&
      template.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) {
    throw new ConvexError(
      `This lab already has an agenda template called “${name}”.`,
    );
  }
}

/** Whoever saved it, or the PI. See the module note. */
function canManage(
  template: Doc<"sessionTemplates">,
  membership: Doc<"memberships">,
): boolean {
  return (
    template.createdBy === membership.userId || membership.role === "pi"
  );
}

/**
 * A template the caller can at least see, plus the membership that allowed it
 * — the shape `requireCollectionAccess` uses, and for the same reason: the
 * caller's role is the next thing every one of these mutations asks about.
 */
async function requireTemplateAccess(
  ctx: QueryCtx | MutationCtx,
  templateId: Id<"sessionTemplates">,
): Promise<{
  template: Doc<"sessionTemplates">;
  membership: Doc<"memberships">;
}> {
  const template = await ctx.db.get(templateId);
  if (template === null) {
    throw new ConvexError("That agenda template is gone.");
  }
  const membership = await requireMembership(ctx, template.labId);
  return { template, membership };
}

async function labTemplates(
  ctx: QueryCtx | MutationCtx,
  labId: Id<"labs">,
): Promise<Doc<"sessionTemplates">[]> {
  return await ctx.db
    .query("sessionTemplates")
    .withIndex("by_lab", (q) => q.eq("labId", labId))
    .take(MAX_TEMPLATES_PER_LAB + 1);
}

/* -------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------- */

/**
 * Every shape the lab keeps, by name.
 *
 * The agenda text comes back with the list rather than behind a second query.
 * The cap is twelve and each one stops at four thousand characters, so the
 * whole payload is bounded at something under fifty kilobytes for a lab that
 * has filled every slot — and the surface that subscribes to this is the one
 * that needs to show you what a template says *before* you apply it, which a
 * second round trip on hover would make feel like a page.
 */
export const listTemplates = query({
  args: { labId: v.id("labs") },
  returns: v.array(templateSummary),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);
    const templates = await labTemplates(ctx, args.labId);

    // A handful of authors across a dozen rows; one read each rather than one
    // per template, the way `listCollections` does it.
    const names = new Map<Id<"users">, string | undefined>();
    for (const template of templates) {
      if (!names.has(template.createdBy)) {
        const user = await ctx.db.get(template.createdBy);
        names.set(template.createdBy, user?.name ?? user?.email);
      }
    }

    return templates
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((template) => ({
        _id: template._id,
        name: template.name,
        title: template.title,
        presenterNotes: template.presenterNotes,
        createdByName: names.get(template.createdBy),
        canManage: canManage(template, membership),
      }));
  },
});

/* -------------------------------------------------------------------------
 * Writes
 * ---------------------------------------------------------------------- */

export const saveTemplate = mutation({
  args: {
    labId: v.id("labs"),
    name: v.string(),
    title: v.optional(v.string()),
    presenterNotes: v.string(),
  },
  returns: v.id("sessionTemplates"),
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.labId);
    const name = cleanTemplateName(args.name);
    const presenterNotes = cleanTemplateNotes(args.presenterNotes);

    const existing = await labTemplates(ctx, args.labId);
    if (existing.length >= MAX_TEMPLATES_PER_LAB) {
      throw new ConvexError(
        `This lab already keeps ${MAX_TEMPLATES_PER_LAB} agenda templates. Delete one before saving another.`,
      );
    }
    requireNameFree(existing, name);

    const title = cleanTitle(args.title);
    return await ctx.db.insert("sessionTemplates", {
      labId: args.labId,
      name,
      ...(title !== undefined ? { title } : {}),
      presenterNotes,
      createdBy: membership.userId,
    });
  },
});

/**
 * Edit a shape in place. Whoever saved it, or the PI.
 *
 * Every field is optional and only what is sent is written, which is what lets
 * the title be *cleared* — sending an empty string means "this shape does not
 * imply a title after all", and the sessions it names go back to being known
 * by their papers. The agenda cannot be cleared the same way, because a
 * template with no agenda is a row with nothing to apply; `cleanTemplateNotes`
 * refuses it.
 */
export const updateTemplate = mutation({
  args: {
    templateId: v.id("sessionTemplates"),
    name: v.optional(v.string()),
    title: v.optional(v.string()),
    presenterNotes: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { template, membership } = await requireTemplateAccess(
      ctx,
      args.templateId,
    );
    if (!canManage(template, membership)) {
      throw new ConvexError(
        "Only the member who saved this template, or the lab's PI, can change it.",
      );
    }

    const patch: Partial<Doc<"sessionTemplates">> = {};
    if (args.name !== undefined) {
      const name = cleanTemplateName(args.name);
      if (name !== template.name) {
        // The rule a new template is held to. Without it, editing was the way
        // around it: two shapes the picker draws identically, reached by
        // renaming one onto the other.
        requireNameFree(
          await labTemplates(ctx, template.labId),
          name,
          template._id,
        );
        patch.name = name;
      }
    }
    if (args.title !== undefined) {
      patch.title = cleanTitle(args.title);
    }
    if (args.presenterNotes !== undefined) {
      patch.presenterNotes = cleanTemplateNotes(args.presenterNotes);
    }

    if (Object.keys(patch).length === 0) {
      return null;
    }
    await ctx.db.patch(template._id, patch);
    return null;
  },
});

/**
 * Delete the shape, not the meetings.
 *
 * Sessions scheduled from a template hold their own copy of what it said, so
 * nothing on the calendar changes and no presenter loses notes they have
 * already started editing. There is nothing to cascade into: the copy was made
 * at scheduling time precisely so that this delete is local.
 */
export const deleteTemplate = mutation({
  args: { templateId: v.id("sessionTemplates") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { template, membership } = await requireTemplateAccess(
      ctx,
      args.templateId,
    );
    if (!canManage(template, membership)) {
      throw new ConvexError(
        "Only the member who saved this template, or the lab's PI, can delete it.",
      );
    }
    await ctx.db.delete(template._id);
    return null;
  },
});
