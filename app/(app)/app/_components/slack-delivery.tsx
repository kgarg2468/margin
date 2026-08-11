"use client";

import { api } from "@/convex/_generated/api";
import {
  errorClass,
  eyebrowClass,
  inputClass,
  labelClass,
  secondaryButtonClass,
  skeletonClass,
} from "@/lib/ui";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { useRef, useState } from "react";
import { ConfirmAction } from "./confirm-action";
import { readableError } from "./errors";
import type { LabSummary } from "./lab-provider";

/**
 * Where the lab's artifacts go when they leave the app.
 *
 * Two audiences in one section, on purpose. **Every member sees whether the
 * lab posts to Slack**, because turning it on means the notes they write can be
 * read by whoever is in that channel — which may be more people than the lab —
 * and somebody whose writing leaves the building is owed that fact in the
 * product rather than by asking. Only the PI sees the controls, and *nobody*
 * sees the URL: `slack.status` does not return it, so there is nothing here to
 * render even for the person who pasted it (see `convex/credentials.guard.test.ts`).
 *
 * The field is a password field, which is not theatre. A PI wiring this up
 * during a lab meeting is doing it on a projector, and a Slack incoming webhook
 * is a bearer credential — anyone who reads it off the screen can post into the
 * lab's channel as the lab, indefinitely. There is nothing to reveal it with,
 * because there is nothing anybody needs to read back: a wrong paste is
 * refused at the moment it is made, with the reason.
 */

/**
 * The statuses that mean the channel itself is the problem.
 *
 * Slack answers an archived channel, or one Margin's webhook was removed from,
 * with a `404`; a revoked webhook with a `403`. Those earn the sentence about
 * the channel possibly being gone. A `400` does not — it would be Margin's
 * fault, and guessing at the lab's Slack workspace on the strength of our own
 * bug is how a settings page starts lying.
 */
const CHANNEL_IS_GONE = new Set([403, 404, 410]);
export function SlackDelivery({ lab }: { lab: LabSummary }) {
  const status = useQuery(api.slack.status, { labId: lab._id });
  const connect = useMutation(api.slack.connect);
  const disconnect = useMutation(api.slack.disconnect);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Read off the field rather than mirrored into state: a credential has no
  // business in a React tree it does not have to be in, and what a failed
  // paste needs is for the value to still be sitting in the box.
  const field = useRef<HTMLInputElement>(null);

  if (status === undefined) {
    return (
      <section className="flex flex-col gap-5">
        <h2 className={eyebrowClass}>Slack</h2>
        <span
          aria-label="Loading"
          role="status"
          className={`${skeletonClass} h-6 w-56`}
        />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <h2 className={eyebrowClass}>Slack</h2>

      <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
        {status.connected ? (
          <>
            This lab posts to a Slack channel. Three things go there and nothing
            else: the presenter&rsquo;s brief once they mark it reviewed, what
            the margin holds two hours before a session, and the write-up once
            it&rsquo;s approved. Anything a member marked lab-visible can appear
            in one, so everyone in that channel can read it.
          </>
        ) : (
          <>
            Margin can post a lab&rsquo;s briefs, session line-ups and approved
            write-ups into a Slack channel. It needs an incoming webhook, not an
            app &mdash; no workspace admin, nothing to install, and Margin can
            do nothing in Slack except post to the one channel.
          </>
        )}
      </p>

      {/*
        Said to everyone, not only the PI. A member was told their lab-visible
        notes reach a channel; if they have stopped reaching it, that is a
        change to the thing they were told, and they should not have to be the
        PI to find out. The status code is quoted rather than paraphrased —
        whoever ends up in Slack's own settings looking for the cause is
        looking for that number.
      */}
      {status.connected && status.lastDeliveryFailed !== null && (
        <p role="status" className={`${errorClass} max-w-prose`}>
          The last post didn&rsquo;t arrive &mdash; Slack answered{" "}
          {status.lastDeliveryFailed.statusCode}.{" "}
          {CHANNEL_IS_GONE.has(status.lastDeliveryFailed.statusCode)
            ? "The channel may have been archived, or Margin’s webhook removed from it."
            : "Slack wouldn’t take the message."}{" "}
          Nothing has reached Slack since.{" "}
          {status.canManage
            ? "Disconnect and paste a new webhook URL to start posting again."
            : "Your PI can reconnect it."}{" "}
          Every brief, line-up and write-up is still in Margin.
        </p>
      )}

      {!status.canManage ? (
        <p className="font-sans text-sm text-ink-faint">
          {status.connected
            ? "Your PI set this up. Only they can change it."
            : "Not set up. Only the lab’s PI can connect a channel."}
        </p>
      ) : status.connected ? (
        <div className="flex flex-wrap items-baseline gap-4">
          <span className="font-sans text-sm text-ink">
            {status.lastDeliveryFailed === null
              ? "Connected to a channel."
              : "Connected to a channel, but posts aren’t arriving."}
          </span>
          <ConfirmAction
            label="Disconnect"
            confirmLabel={`Stop posting ${lab.name} to Slack`}
            run={async () => {
              setError(null);
              try {
                await disconnect({ labId: lab._id });
              } catch (caught) {
                setError(
                  readableError(caught, "We couldn't disconnect that channel."),
                );
              }
            }}
          />
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            setPending(true);
            try {
              await connect({
                labId: lab._id,
                webhookUrl: field.current?.value ?? "",
              });
              if (field.current !== null) {
                field.current.value = "";
              }
            } catch (caught) {
              setError(
                readableError(caught, "We couldn't save that webhook URL."),
              );
            } finally {
              setPending(false);
            }
          }}
        >
          <label htmlFor="slack-webhook" className={labelClass}>
            Incoming webhook URL
          </label>
          <input
            ref={field}
            id="slack-webhook"
            name="webhookUrl"
            type="password"
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="https://hooks.slack.com/services/…"
            className={`${inputClass} max-w-lg`}
          />
          <p className="max-w-prose font-sans text-xs leading-relaxed text-ink-faint">
            In Slack: Apps &rarr; Incoming Webhooks &rarr; Add to Slack, pick the
            channel, then copy the whole URL. Margin keeps the URL and nothing
            else about your workspace.
          </p>

          {error !== null && (
            <p role="alert" className={`${errorClass} pop-in`}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={pending}
            className={`${secondaryButtonClass} self-start`}
          >
            {pending ? "Connecting…" : "Connect a channel"}
          </button>
        </form>
      )}

      {status.connected && error !== null && (
        <p role="alert" className={`${errorClass} pop-in`}>
          {error}
        </p>
      )}
    </section>
  );
}
