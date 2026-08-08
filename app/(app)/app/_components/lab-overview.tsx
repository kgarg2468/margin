"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatWhen, isUpcoming, isoAt, relativeWhen } from "@/lib/sessions-ui";
import {
  errorClass,
  eyebrowClass,
  labelClass,
  secondaryButtonClass,
  skeletonClass,
  textareaClass,
} from "@/lib/ui";
import { useAction, useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { SessionStatusChip } from "../sessions/_components/session-row";
import { ConfirmAction } from "./confirm-action";
import { DigestInbox } from "./digest";
import { readableError } from "./errors";
import { InviteNotice } from "./lab-provider";
import type { LabSummary } from "./lab-provider";
import { JoinLabCard } from "./onboarding";

/**
 * Emailing an invitation needs a Resend key on the Convex deployment, which
 * the browser cannot see. Set `NEXT_PUBLIC_AUTH_EMAIL=1` alongside it and the
 * form appears; leave it unset and this section is the code list it has
 * always been.
 */
const EMAIL_ENABLED = process.env.NEXT_PUBLIC_AUTH_EMAIL === "1";

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function LabOverview({ lab }: { lab: LabSummary }) {
  return (
    <div className="flex flex-col gap-12">
      <InviteNotice />

      <header className="flex flex-col gap-3 border-l border-rule pl-6">
        <h1 className="font-serif text-4xl tracking-tight text-ink-strong">
          {lab.name}
        </h1>
        <p className="font-sans text-sm text-ink-muted">
          {lab.institution ? `${lab.institution} · ` : ""}
          {lab.memberCount} {lab.memberCount === 1 ? "member" : "members"}
          {lab.role === "pi" ? " · you are the PI" : ""}
        </p>
      </header>

      <NextSession lab={lab} />
      <DigestInbox labId={lab._id} />

      <Members lab={lab} />
      {lab.role === "pi" && <Invites lab={lab} />}

      <section className="flex flex-col gap-4 border-t border-rule pt-8">
        <details className="group flex flex-col gap-4">
          <summary className="cursor-pointer font-sans text-sm text-accent underline-offset-4 hover:underline">
            Joining another lab?
          </summary>
          <div className="mt-4 max-w-md">
            <JoinLabCard />
          </div>
        </details>
      </section>

      <LeaveLab lab={lab} />
    </div>
  );
}

function Members({ lab }: { lab: LabSummary }) {
  const members = useQuery(api.labs.listMembers, { labId: lab._id });
  const removeMember = useMutation(api.labs.removeMember);
  const [error, setError] = useState<string | null>(null);

  async function remove(userId: Id<"users">) {
    setError(null);
    try {
      await removeMember({ labId: lab._id, userId });
    } catch (caught) {
      setError(readableError(caught, "We couldn't remove that member."));
    }
  }

  return (
    <section className="flex flex-col gap-5">
      <h2 className={eyebrowClass}>Members</h2>
      {members === undefined ? (
        <span aria-label="Loading" role="status" className={`${skeletonClass} h-6 w-56`} />
      ) : (
        <ul className="flex flex-col divide-y divide-rule border-y border-rule">
          {members.map((member) => (
            <li
              key={member.userId}
              className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3"
            >
              <span className="flex items-baseline gap-3">
                <span className="font-serif text-lg text-ink">
                  {member.name ?? member.email ?? "Unnamed"}
                </span>
                {member.role === "pi" && (
                  <span className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                    PI
                  </span>
                )}
              </span>
              <span className="flex items-baseline gap-4">
                <span className="font-sans text-xs text-ink-faint">
                  {member.email} · joined {formatDate(member.joinedAt)}
                </span>
                {lab.role === "pi" && !member.isYou && (
                  <ConfirmAction
                    label="Remove"
                    confirmLabel={`Remove ${member.name ?? member.email ?? "them"}`}
                    run={() => remove(member.userId)}
                  />
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {error !== null && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
    </section>
  );
}

function Invites({ lab }: { lab: LabSummary }) {
  const invites = useQuery(api.invites.listInvites, { labId: lab._id });
  const createInvite = useMutation(api.invites.createInvite);
  const revokeInvite = useMutation(api.invites.revokeInvite);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <section className="flex flex-col gap-5">
      <h2 className={eyebrowClass}>Invite codes</h2>
      <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
        Anyone with a live code can join as a member. Codes last 14 days, admit
        up to 25 people, and can be revoked at any time.
      </p>

      {invites === undefined ? (
        <span aria-label="Loading" role="status" className={`${skeletonClass} h-6 w-56`} />
      ) : invites.length === 0 ? (
        <p className="font-sans text-sm text-ink-faint">
          No live codes. Generate one to bring the lab in.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-rule border-y border-rule">
          {invites.map((invite) => (
            <li
              key={invite._id}
              className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3"
            >
              <code className="font-mono text-base tracking-[0.2em] text-ink-strong">
                {invite.code}
              </code>
              <span className="flex items-baseline gap-4">
                <span className="font-sans text-xs text-ink-faint">
                  {invite.useCount} of {invite.maxUses} used · expires{" "}
                  {formatDate(invite.expiresAt)}
                </span>
                <ConfirmAction
                  label="Revoke"
                  confirmLabel={`Revoke ${invite.code}`}
                  run={async () => {
                    setError(null);
                    try {
                      await revokeInvite({ inviteId: invite._id });
                    } catch (caught) {
                      setError(
                        readableError(
                          caught,
                          "We couldn't revoke that code. Please try again.",
                        ),
                      );
                    }
                  }}
                />
              </span>
            </li>
          ))}
        </ul>
      )}

      {error !== null && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={pending}
        className={`${secondaryButtonClass} self-start`}
        onClick={async () => {
          setError(null);
          setPending(true);
          try {
            await createInvite({ labId: lab._id });
          } catch (caught) {
            setError(
              readableError(
                caught,
                "We couldn't generate a code. Please try again.",
              ),
            );
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? "Generating…" : "New invite code"}
      </button>

      {EMAIL_ENABLED && <InviteByEmail lab={lab} />}
    </section>
  );
}

/**
 * The same code, delivered instead of dictated.
 *
 * A PI reading a code out in a lab meeting is fine; a PI trying to onboard a
 * new postdoc who is not in the room is not. This mints a code sized to the
 * batch and mails each address the link that carries it, so the recipient's
 * first move is clicking, not typing. The code then appears in the list above
 * like any other and can be revoked the same way.
 *
 * Margin does not keep the addresses. Who was invited is not a fact the
 * product needs; who joined is, and the ledger already has it.
 */
function InviteByEmail({ lab }: { lab: LabSummary }) {
  const inviteByEmail = useAction(api.invites.inviteByEmail);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <form
      className="flex flex-col gap-3 border-t border-rule pt-6"
      onSubmit={async (event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const form = event.currentTarget;
        setError(null);
        setSent(null);
        setPending(true);
        try {
          const result = await inviteByEmail({
            labId: lab._id,
            emails: [String(formData.get("emails") ?? "")],
          });
          form.reset();
          setSent(
            result.failed === 0
              ? `Sent to ${result.sent} ${result.sent === 1 ? "person" : "people"}. The code is in the list above.`
              : `Sent to ${result.sent}; ${result.failed} didn't go through. Try those addresses again.`,
          );
        } catch (caught) {
          setError(
            readableError(caught, "We couldn't send those invitations."),
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <label htmlFor="invite-emails" className={labelClass}>
        Or send it by email
      </label>
      <textarea
        id="invite-emails"
        name="emails"
        rows={2}
        required
        spellCheck={false}
        placeholder="ada@university.edu, chen@university.edu"
        className={`${textareaClass} font-sans`}
      />
      <p className="font-sans text-xs leading-relaxed text-ink-faint">
        Commas, spaces or new lines. Each person gets a link that signs them in
        and drops them straight into {lab.name}.
      </p>

      {error !== null && (
        <p role="alert" className={`${errorClass} pop-in`}>
          {error}
        </p>
      )}
      {sent !== null && (
        <p
          role="status"
          className="pop-in border-l-2 border-accent pl-3 font-sans text-sm text-ink"
        >
          {sent}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className={`${secondaryButtonClass} self-start`}
      >
        {pending ? "Sending…" : "Send invitations"}
      </button>
    </form>
  );
}

/**
 * Leaving is the member's half of the roster; `Members` above is the PI's.
 *
 * A lab's only PI can't leave — there would be nobody left who can invite or
 * manage anyone — so they get the reason instead of a button that only fails.
 */
function LeaveLab({ lab }: { lab: LabSummary }) {
  const leaveLab = useMutation(api.labs.leaveLab);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="flex flex-col gap-3 border-t border-rule pt-8">
      <h2 className={eyebrowClass}>Leaving</h2>
      {lab.role === "pi" ? (
        <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
          You are the PI of {lab.name}, so you can&rsquo;t leave it — a lab has
          to have someone who can manage the roster. Handing the lab over comes
          later.
        </p>
      ) : (
        <>
          <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
            You&rsquo;ll lose access to {lab.name}&rsquo;s papers and sessions.
            The annotations you wrote for the lab stay with it.
          </p>
          <ConfirmAction
            label="Leave this lab"
            confirmLabel={`Leave ${lab.name}`}
            run={async () => {
              setError(null);
              try {
                await leaveLab({ labId: lab._id });
              } catch (caught) {
                setError(readableError(caught, "We couldn't do that."));
              }
            }}
          />
        </>
      )}

      {error !== null && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * The next meeting, and nothing else about the calendar.
 *
 * A lab home page answers one scheduling question — "when are we next, and on
 * what" — and every further row is the calendar's job. A live session takes the
 * slot over, because a member landing here while the lab is meeting should be
 * one click from the room.
 */
function NextSession({ lab }: { lab: LabSummary }) {
  const sessions = useQuery(api.sessions.listSessions, { labId: lab._id });

  // `listSessions` is furthest-future first, so the soonest meeting still ahead
  // is the last one in the upcoming run.
  const upcoming = (sessions ?? []).filter((session) =>
    isUpcoming(session.status),
  );
  const next = upcoming[upcoming.length - 1];
  const live = upcoming.find((session) => session.status === "live") ?? next;

  return (
    <section className="flex flex-col gap-4">
      <h2 className={eyebrowClass}>Next session</h2>

      {sessions === undefined ? (
        <span aria-label="Loading" role="status" className={`${skeletonClass} h-6 w-56`} />
      ) : live === undefined ? (
        <>
          <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
            Nothing on the calendar. A journal club session is a paper, a time,
            and whoever is presenting — the lab reads into the margin
            beforehand, and the meeting runs off what it flagged.
          </p>
          <Link
            href="/app/sessions"
            className="self-start font-sans text-sm text-accent underline-offset-4 hover:underline"
          >
            Schedule a session
          </Link>
        </>
      ) : (
        <div className="flex flex-col gap-1 border-l border-rule pl-5">
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Link
              href={`/app/sessions/${live._id}`}
              className="font-serif text-2xl leading-snug text-ink-strong underline-offset-4 hover:underline"
            >
              {live.title ?? live.paperTitle ?? "A session"}
            </Link>
            <SessionStatusChip status={live.status} />
          </span>
          <span className="font-sans text-sm text-ink-muted">
            <time dateTime={isoAt(live.scheduledAt)}>
              {formatWhen(live.scheduledAt)}
            </time>
            {" · "}
            {relativeWhen(live.scheduledAt)}
          </span>
          <span className="font-sans text-xs text-ink-faint">
            {live.presenterName ?? "No presenter"}
            {live.title !== undefined && live.paperTitle !== undefined
              ? ` · ${live.paperTitle}`
              : ""}
          </span>
        </div>
      )}
    </section>
  );
}
