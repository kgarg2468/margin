"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  errorClass,
  inputClass,
  labelClass,
  linkButtonClass,
  selectClass,
  textareaClass,
} from "@/lib/ui";
import type { FunctionReturnType } from "convex/server";
import { useMutation } from "convex/react";
import { useState } from "react";
import { ConfirmAction } from "../../_components/confirm-action";
import { readableError } from "../../_components/errors";

export type AgendaTemplate = FunctionReturnType<
  typeof api.sessionTemplates.listTemplates
>[number];

/** The ceilings `convex/sessionTemplates.ts` enforces, so the field stops you before the server has to. */
const NAME_LIMIT = 60;
const TITLE_LIMIT = 200;
const AGENDA_LIMIT = 4_000;

/**
 * The lab's saved meeting shapes, where a meeting gets scheduled.
 *
 * The schedule form's rule is that it asks for a paper, a time and a
 * presenter, and nothing else — a title and presenter notes are edits on the
 * session afterwards, because a form that asks for them up front asks at the
 * moment nobody has decided yet. A template is the exception that proves it:
 * it is precisely the part that *was* decided, months ago, and is the same
 * every week. So this adds one control, not a notes field. You pick a shape,
 * you can see what it says, and the presenter still writes the paper-specific
 * half on the session itself.
 *
 * Saving lives here too, rather than on the session page, which means the
 * agenda gets typed once in the place it is about to be used. The session page
 * is where notes are *edited*, and lifting an edited set of notes back out into
 * a template is a different affordance for a different week.
 */
export function AgendaTemplateField({
  labId,
  templates,
  value,
  onChange,
}: {
  labId: Id<"labs">;
  /** `undefined` while the lab's templates are still loading. */
  templates: AgendaTemplate[] | undefined;
  value: Id<"sessionTemplates"> | null;
  onChange: (templateId: Id<"sessionTemplates"> | null) => void;
}) {
  const saveTemplate = useMutation(api.sessionTemplates.saveTemplate);
  const updateTemplate = useMutation(api.sessionTemplates.updateTemplate);
  const deleteTemplate = useMutation(api.sessionTemplates.deleteTemplate);

  const [mode, setMode] = useState<"idle" | "new" | "edit">("idle");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [agenda, setAgenda] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const chosen = templates?.find((template) => template._id === value) ?? null;
  const empty = templates !== undefined && templates.length === 0;
  /** Whether there is a `<select>` for a `<label>` to point at — see below. */
  const hasPicker = templates !== undefined && !empty;

  function close() {
    setMode("idle");
    setName("");
    setTitle("");
    setAgenda("");
    // The refusal goes with the editor that earned it. Left behind, it sits
    // under the picker with nothing left to refuse.
    setError(null);
  }

  async function submit() {
    // The Save button is `disabled={pending}`; the Enter key is not, and key
    // repeat is a real thing. Two overlapping saves of the same name means the
    // second is correctly refused for being a duplicate of the first — and
    // that refusal lands after `close()`, so a save that worked reads as one
    // that failed.
    if (pending) {
      return;
    }
    setError(null);
    setPending(true);
    try {
      if (mode === "new") {
        // Selected on the way in: you saved this shape because you are about
        // to use it, and making you then find it in the list is asking twice.
        const templateId = await saveTemplate({
          labId,
          name,
          title,
          presenterNotes: agenda,
        });
        onChange(templateId);
      } else if (mode === "edit" && chosen !== null) {
        await updateTemplate({
          templateId: chosen._id,
          name,
          title,
          presenterNotes: agenda,
        });
      } else {
        // The shape was deleted out from under this editor while it was open.
        // Closing here would collapse the panel as though the save had worked
        // and take the typed text with it — which is the exact dishonesty
        // `cleanTemplateNotes` refuses to commit on the server. Say so and
        // leave the editor standing; the words are still in state.
        setError(
          "That template was deleted while you were editing it. Your text is still here — save it as a new one.",
        );
        // And make that sentence actionable: the panel is now a new-template
        // editor holding the same words, so the next press does what the
        // message just said rather than hitting this branch again.
        setMode("new");
        return;
      }
      close();
    } catch (caught) {
      setError(readableError(caught, "That template wouldn't save."));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      {/* The picker only exists once the lab has saved a shape, and on day one
          no lab has. A `<label for>` pointing at nothing is worse than a
          heading: it promises a control that is not there. So the word is a
          label exactly when there is something to label. */}
      {hasPicker ? (
        <label htmlFor="session-template" className={labelClass}>
          Agenda
        </label>
      ) : (
        <span className={labelClass}>Agenda</span>
      )}

      {templates === undefined ? (
        <p className="font-sans text-sm text-ink-faint">
          Looking for saved shapes…
        </p>
      ) : empty ? (
        <p className="max-w-prose font-serif text-sm leading-relaxed text-ink-muted">
          Nothing saved. If the lab runs the same shape every week — the
          background, the figure everyone argues about, what we&rsquo;d do
          differently — save it once and it lands in every session&rsquo;s
          notes.
        </p>
      ) : (
        <select
          id="session-template"
          // `chosen`, not `value`: if somebody deletes a template while this
          // form is open the subscription drops it from the list, and the
          // picker should visibly fall back to "no template" rather than sit
          // on an id that no longer resolves. What is shown is what is sent.
          value={chosen?._id ?? ""}
          onChange={(event) =>
            onChange(
              event.target.value.length === 0
                ? null
                : (event.target.value as Id<"sessionTemplates">),
            )
          }
          className={selectClass}
        >
          <option value="">No template — notes come later</option>
          {templates.map((template) => (
            <option key={template._id} value={template._id}>
              {template.name}
            </option>
          ))}
        </select>
      )}

      {chosen !== null && mode !== "edit" && (
        <figure className="pop-in mt-1 flex flex-col gap-1.5 border-l-2 border-rule pl-3">
          {/* The agenda as it will arrive: same serif as the notes it becomes,
              line breaks intact, and scrollable rather than truncated — a
              shape you can only see the first half of is one you have to
              schedule the meeting to read. */}
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap font-serif text-sm leading-relaxed text-ink-muted">
            {chosen.presenterNotes}
          </p>
          <figcaption className="font-sans text-xs text-ink-faint">
            Becomes this session&rsquo;s presenter notes, editable on the
            session afterwards.
            {chosen.title !== undefined && ` Titles it “${chosen.title}”.`}
          </figcaption>
        </figure>
      )}

      {mode === "idle" ? (
        <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-sans text-xs">
          <button
            type="button"
            onClick={() => {
              close();
              setMode("new");
            }}
            className={`${linkButtonClass} tap-target text-xs`}
          >
            Save an agenda template
          </button>

          {chosen !== null && chosen.canManage && (
            <>
              <button
                type="button"
                onClick={() => {
                  setName(chosen.name);
                  setTitle(chosen.title ?? "");
                  setAgenda(chosen.presenterNotes);
                  setMode("edit");
                }}
                className={`${linkButtonClass} tap-target text-xs`}
              >
                Edit “{chosen.name}”
              </button>
              <ConfirmAction
                label="Delete it"
                confirmLabel={`Delete “${chosen.name}” — scheduled sessions keep their notes`}
                tone="faint"
                run={async () => {
                  setError(null);
                  try {
                    await deleteTemplate({ templateId: chosen._id });
                    onChange(null);
                  } catch (caught) {
                    setError(
                      readableError(caught, "That template wouldn't delete."),
                    );
                  }
                }}
              />
            </>
          )}

          {chosen !== null && !chosen.canManage && (
            <span className="text-ink-faint">
              Saved by {chosen.createdByName ?? "another member"}
            </span>
          )}
        </div>
      ) : (
        // Not a <form>: this whole field sits inside the schedule form, and a
        // form inside a form is not a thing the HTML parser will build. Which
        // also means Enter in these inputs would submit the *outer* one and
        // schedule a session mid-sentence — so the two single-line fields
        // catch it and save the template instead, which is what pressing
        // Enter in a small editor is supposed to do.
        <div className="pop-in mt-1 flex flex-col gap-3 rounded-sm border border-rule p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              autoFocus
              value={name}
              maxLength={NAME_LIMIT}
              aria-label="Template name"
              placeholder="Methods week"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
                if (event.key === "Escape") {
                  close();
                }
              }}
              className={inputClass}
            />
            <input
              value={title}
              maxLength={TITLE_LIMIT}
              aria-label="Session title this shape gives"
              placeholder="Optional — the session's title…"
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
                if (event.key === "Escape") {
                  close();
                }
              }}
              className={inputClass}
            />
          </div>

          <textarea
            value={agenda}
            rows={5}
            maxLength={AGENDA_LIMIT}
            aria-label="Agenda"
            placeholder={
              "15m — background and where this sits\n" +
              "20m — methods, and the figure we argue about\n" +
              "10m — what we'd do differently"
            }
            // Enter is a newline here, because an agenda is an outline. Escape
            // still closes.
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                close();
              }
            }}
            onChange={(event) => setAgenda(event.target.value)}
            className={textareaClass}
          />

          <div className="flex flex-wrap items-center gap-4 font-sans text-xs">
            <button
              type="button"
              disabled={pending}
              onClick={() => void submit()}
              className={`${linkButtonClass} tap-target text-xs disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {pending
                ? "Saving…"
                : mode === "new"
                  ? "Save the shape"
                  : "Save changes"}
            </button>
            <button
              type="button"
              onClick={close}
              className="tap-target text-ink-faint underline-offset-4 hover:text-ink-muted hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <p role="alert" aria-live="polite" className={`${errorClass} mt-1`}>
          {error}
        </p>
      )}
    </div>
  );
}
