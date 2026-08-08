"use client";

import { api } from "@/convex/_generated/api";
import {
  cardClass,
  errorClass,
  eyebrowClass,
  inputClass,
  labelClass,
  primaryButtonClass,
} from "@/lib/ui";
import { useMutation } from "convex/react";
import { useState } from "react";
import { readableError } from "./errors";
import { InviteNotice, useLabs } from "./lab-provider";

export function Onboarding() {
  return (
    <div className="flex flex-col gap-10">
      <InviteNotice />

      <header className="flex flex-col gap-3 border-l border-rule pl-6">
        <h1 className="font-serif text-4xl tracking-tight text-ink-strong">
          Two ways in
        </h1>
        <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
          Margin is organised around labs. Start one if you run the journal
          club, or join the one your PI already set up.
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        <CreateLabCard />
        <JoinLabCard />
      </div>
    </div>
  );
}

function CreateLabCard() {
  const createLab = useMutation(api.labs.createLab);
  const { selectLab } = useLabs();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <section className={`${cardClass} flex flex-col gap-5`}>
      <div className="flex flex-col gap-2">
        <span className={eyebrowClass}>Start a lab</span>
        <p className="font-serif text-base leading-relaxed text-ink-muted">
          You become the PI. Invite the rest of the group with a code.
        </p>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          setError(null);
          setPending(true);
          try {
            const labId = await createLab({
              name: String(formData.get("name") ?? ""),
              institution: String(formData.get("institution") ?? "") || undefined,
            });
            // Land in the lab you just made rather than in whichever one
            // happens to sort first — this card is also reachable from the
            // overview of an existing lab.
            selectLab(labId);
          } catch (caught) {
            setError(readableError(caught, "We couldn't create that lab."));
          } finally {
            setPending(false);
          }
        }}
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="lab-name" className={labelClass}>
            Lab name
          </label>
          <input
            id="lab-name"
            name="name"
            required
            maxLength={120}
            placeholder="Chen Lab"
            className={inputClass}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="lab-institution" className={labelClass}>
            Institution <span className="normal-case">(optional)</span>
          </label>
          <input
            id="lab-institution"
            name="institution"
            placeholder="Rice University"
            className={inputClass}
          />
        </div>

        {error !== null && (
          <p role="alert" className={errorClass}>
            {error}
          </p>
        )}

        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Creating…" : "Create lab"}
        </button>
      </form>
    </section>
  );
}

export function JoinLabCard() {
  const redeemInvite = useMutation(api.invites.redeemInvite);
  const { selectLab } = useLabs();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <section className={`${cardClass} flex flex-col gap-5`}>
      <div className="flex flex-col gap-2">
        <span className={eyebrowClass}>Join a lab</span>
        <p className="font-serif text-base leading-relaxed text-ink-muted">
          Paste the eight-character code your lab sent you.
        </p>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          setError(null);
          setPending(true);
          try {
            const { labId } = await redeemInvite({
              code: String(formData.get("code") ?? ""),
            });
            // Land in the lab you just joined. Without this you arrive in
            // whichever lab sorts first, which for anyone in two labs is the
            // wrong one — and this card is also reachable from inside a lab.
            selectLab(labId);
          } catch (caught) {
            setError(readableError(caught, "That invite code is not valid."));
          } finally {
            setPending(false);
          }
        }}
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="invite-code" className={labelClass}>
            Invite code
          </label>
          <input
            id="invite-code"
            name="code"
            required
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="K7M2QP4R"
            className={`${inputClass} font-mono uppercase tracking-[0.2em]`}
          />
        </div>

        {error !== null && (
          <p role="alert" className={errorClass}>
            {error}
          </p>
        )}

        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Joining…" : "Join lab"}
        </button>
      </form>
    </section>
  );
}
