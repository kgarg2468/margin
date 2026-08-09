"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  defaultScheduleAt,
  fromLocalInputValue,
  toLocalInputValue,
} from "@/lib/sessions-ui";
import {
  errorClass,
  inputClass,
  labelClass,
  panelClass,
  primaryButtonClass,
  selectClass,
} from "@/lib/ui";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { readableError } from "../../_components/errors";
import { byline } from "../../library/_components/paper-meta";
import { AgendaTemplateField } from "./agenda-templates";

/**
 * Putting a meeting on the calendar: a paper, a time, and whoever is standing
 * up to present it.
 *
 * Three fields and no wizard. Everything else a session can carry — a title,
 * presenter notes — is an edit on the session itself, because a form that asks
 * for them up front asks them at the moment nobody has decided yet.
 *
 * The agenda picker is the one exception, and it is an exception that agrees
 * with the rule. It does not ask what this meeting's agenda is; it offers the
 * shape the lab settled on months ago and runs every week, which is the one
 * part of a session that *has* been decided before the paper was chosen. One
 * control, no notes field: what a template puts in the session is presenter
 * notes, and presenter notes are still edited on the session.
 *
 * A paper whose text layer hasn't landed is still schedulable, and says so.
 * Labs put the next four weeks on the calendar in one sitting, often before the
 * PDF is in, and refusing that would mean coming back later to do the clerical
 * half twice.
 */
export function ScheduleForm({
  labId,
  defaultPaperId,
  onCancel,
}: {
  labId: Id<"labs">;
  /** Pre-selected when the form was opened from a paper. */
  defaultPaperId?: Id<"papers">;
  onCancel?: () => void;
}) {
  const papers = useQuery(api.papers.listPapers, { labId });
  const members = useQuery(api.labs.listMembers, { labId });
  const templates = useQuery(api.sessionTemplates.listTemplates, { labId });
  const createSession = useMutation(api.sessions.createSession);
  const router = useRouter();

  const [paperId, setPaperId] = useState<string>(defaultPaperId ?? "");
  const [when, setWhen] = useState(() =>
    toLocalInputValue(defaultScheduleAt()),
  );
  const [presenterId, setPresenterId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [templateId, setTemplateId] = useState<Id<"sessionTemplates"> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const you = members?.find((member) => member.isYou);
  const scheduledAt = fromLocalInputValue(when);
  const chosenPaper = paperId.length > 0 ? paperId : (papers?.[0]?._id ?? "");
  const chosenTemplate =
    templates?.find((template) => template._id === templateId) ?? null;

  if (papers !== undefined && papers.length === 0) {
    return (
      <div className={`${panelClass} flex max-w-prose flex-col gap-3`}>
        <p className="font-serif text-base leading-relaxed text-ink-muted">
          A session is a meeting about a paper, and the library is empty. Add
          the paper first and the calendar has something to point at.
        </p>
        <Link
          href="/app/library"
          className="self-start font-sans text-sm text-accent underline-offset-4 hover:underline"
        >
          Go to the library
        </Link>
      </div>
    );
  }

  return (
    <form
      className={`${panelClass} flex max-w-2xl flex-col gap-5`}
      onSubmit={async (event) => {
        event.preventDefault();
        if (scheduledAt === null || chosenPaper.length === 0) {
          setError("Pick a paper and a time first.");
          return;
        }
        setError(null);
        setPending(true);
        try {
          const sessionId = await createSession({
            labId,
            paperId: chosenPaper as Id<"papers">,
            scheduledAt,
            ...(presenterId.length > 0
              ? { presenterId: presenterId as Id<"users"> }
              : {}),
            ...(title.trim().length > 0 ? { title: title.trim() } : {}),
            // The resolved template, not the held id: one deleted while this
            // form was open has already left the picker, and the session
            // should be scheduled with what the form is showing.
            ...(chosenTemplate !== null
              ? { templateId: chosenTemplate._id }
              : {}),
          });
          router.push(`/app/sessions/${sessionId}`);
        } catch (caught) {
          setError(
            readableError(caught, "That session didn't go on the calendar."),
          );
          setPending(false);
        }
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="session-paper" className={labelClass}>
          Paper
        </label>
        {papers === undefined ? (
          <p className="font-sans text-sm text-ink-faint">Loading the shelf…</p>
        ) : (
          <select
            id="session-paper"
            required
            value={chosenPaper}
            onChange={(event) => setPaperId(event.target.value)}
            className={selectClass}
          >
            {papers.map((paper) => (
              <option key={paper._id} value={paper._id}>
                {paper.title}
                {paper.ingestStatus === "ready" ? "" : " — not readable yet"}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="session-when" className={labelClass}>
            When
          </label>
          <input
            id="session-when"
            type="datetime-local"
            required
            value={when}
            min={toLocalInputValue(Date.now())}
            onChange={(event) => setWhen(event.target.value)}
            className={inputClass}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="session-presenter" className={labelClass}>
            Presenter
          </label>
          {members === undefined ? (
            <p className="font-sans text-sm text-ink-faint">Loading the lab…</p>
          ) : (
            <select
              id="session-presenter"
              value={presenterId.length > 0 ? presenterId : (you?.userId ?? "")}
              onChange={(event) => setPresenterId(event.target.value)}
              className={selectClass}
            >
              {members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.isYou
                    ? "You"
                    : (member.name ?? member.email ?? "A lab member")}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="session-title" className={labelClass}>
          Title
        </label>
        <input
          id="session-title"
          type="text"
          value={title}
          autoComplete="off"
          maxLength={200}
          // The placeholder is where the template's title becomes visible
          // rather than a surprise: leave this empty and the session is called
          // what the shape says, type here and yours wins.
          placeholder={
            chosenTemplate?.title !== undefined
              ? `“${chosenTemplate.title}” — from the template…`
              : "Optional — the paper's title is the default…"
          }
          onChange={(event) => setTitle(event.target.value)}
          className={inputClass}
        />
      </div>

      <AgendaTemplateField
        labId={labId}
        templates={templates}
        value={templateId}
        onChange={setTemplateId}
      />

      {error !== null && (
        <p role="alert" aria-live="polite" className={errorClass}>
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Scheduling…" : "Schedule session"}
        </button>
        {onCancel !== undefined && (
          <button
            type="button"
            onClick={onCancel}
            className="font-sans text-sm text-ink-faint underline-offset-4 hover:text-accent hover:underline"
          >
            Never mind
          </button>
        )}
        {papers !== undefined && chosenPaper.length > 0 && (
          <span className="font-sans text-xs text-ink-faint">
            {byline(
              papers.find((paper) => paper._id === chosenPaper) ?? {},
            ) || " "}
          </span>
        )}
      </div>
    </form>
  );
}
