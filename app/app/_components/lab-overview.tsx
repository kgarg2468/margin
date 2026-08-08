"use client";

import { api } from "@/convex/_generated/api";
import {
  cardClass,
  errorClass,
  eyebrowClass,
  secondaryButtonClass,
} from "@/lib/ui";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import type { LabSummary } from "./lab-provider";
import { JoinLabCard } from "./onboarding";

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

      <Members lab={lab} />
      {lab.role === "pi" && <Invites lab={lab} />}

      <section className="flex flex-col gap-5">
        <h2 className={eyebrowClass}>Coming next</h2>
        <div className="grid gap-6 md:grid-cols-2">
          <EmptyState
            title="Library"
            body="Papers your lab is reading. Upload a PDF or paste a DOI and Margin pulls the metadata, extracts the text, and puts it in front of the group."
          />
          <EmptyState
            title="Sessions"
            body="Journal club meetings. Schedule one against a paper, prep in the margins beforehand, and run the live view of what the group flagged."
          />
        </div>
      </section>

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
    </div>
  );
}

function Members({ lab }: { lab: LabSummary }) {
  const members = useQuery(api.labs.listMembers, { labId: lab._id });

  return (
    <section className="flex flex-col gap-5">
      <h2 className={eyebrowClass}>Members</h2>
      {members === undefined ? (
        <p className="font-sans text-sm text-ink-faint">Loading…</p>
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
              <span className="font-sans text-xs text-ink-faint">
                {member.email} · joined {formatDate(member.joinedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Invites({ lab }: { lab: LabSummary }) {
  const invites = useQuery(api.invites.listInvites, { labId: lab._id });
  const createInvite = useMutation(api.invites.createInvite);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <section className="flex flex-col gap-5">
      <h2 className={eyebrowClass}>Invite codes</h2>
      <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
        Anyone with a live code can join as a member. Codes last 14 days and can
        be used by more than one person.
      </p>

      {invites === undefined ? (
        <p className="font-sans text-sm text-ink-faint">Loading…</p>
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
              <span className="font-sans text-xs text-ink-faint">
                {invite.usedCount} used · expires {formatDate(invite.expiresAt)}
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
          } catch {
            setError("We couldn't generate a code. Please try again.");
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? "Generating…" : "New invite code"}
      </button>
    </section>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className={`${cardClass} flex flex-col gap-3`}>
      <span className="flex items-baseline gap-2">
        <h3 className="font-serif text-xl text-ink-strong">{title}</h3>
        <span className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint">
          Soon
        </span>
      </span>
      <p className="font-serif text-base leading-relaxed text-ink-muted">
        {body}
      </p>
    </div>
  );
}
