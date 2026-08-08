"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { PageSurface } from "@/app/(marketing)/_components/hero-surface";
import {
  cardClass,
  errorClass,
  inputClass,
  labelClass,
  linkButtonClass,
  primaryButtonClass,
} from "@/lib/ui";

type Flow = "signIn" | "signUp";

/**
 * Which half of the world broke.
 *
 * A rejected credential is the only failure that comes back as an answer: the
 * `/api/auth` proxy catches what `auth:signIn` threw and replies 400 with a
 * JSON `{ error }`, which @convex-dev/auth rethrows as an Error carrying that
 * message. Everything between the browser and that answer fails earlier and
 * differently — an unreachable server rejects `fetch` with a TypeError, and a
 * 404/405/5xx answers with HTML or bare text, so reading it as JSON throws a
 * SyntaxError before there is any message to carry.
 *
 * Worth telling apart, because the credential copy is an accusation. Saying
 * the password may be too short when the route is simply down sends a reader
 * off to change a password that was never wrong — which is exactly what this
 * screen did when `/api/auth` was 404ing.
 */
function isServiceFailure(error: unknown): boolean {
  if (error instanceof TypeError || error instanceof SyntaxError) {
    return true;
  }
  // A proxied Convex error always has something to say. An Error with nothing
  // in it came from a response that had no `error` field to read.
  return !(error instanceof Error) || error.message.trim().length === 0;
}

function flowFromParam(value: string | null): Flow {
  return value === "signup" ? "signUp" : "signIn";
}

export default function SignInPage() {
  const { signIn } = useAuthActions();
  const router = useRouter();
  const searchParams = useSearchParams();
  // The landing CTAs promise an account, so they arrive at `?flow=signup` and
  // land on the form that makes one. Seeded once: after that the toggle owns
  // the mode, and mirrors it back into the URL below.
  const [flow, setFlow] = useState<Flow>(() =>
    flowFromParam(searchParams.get("flow")),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function switchFlow() {
    const next: Flow = flow === "signIn" ? "signUp" : "signIn";
    setFlow(next);
    setError(null);
    // history rather than the router: the mode is a detail of this screen, and
    // a re-render is not worth a round trip for the RSC payload. Keeps a
    // refresh — and anything the reader copies out of the address bar — on the
    // form they were actually looking at.
    window.history.replaceState(
      null,
      "",
      next === "signUp" ? "/signin?flow=signup" : "/signin",
    );
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const formData = new FormData(event.currentTarget);
    formData.set("flow", flow);

    try {
      await signIn("password", formData);
      router.push("/app");
    } catch (caught) {
      setError(
        isServiceFailure(caught)
          ? "We couldn't reach the sign-in service — that's on us, not on what you typed. Try again in a moment."
          : // Convex Auth deliberately does not say which half of the
            // credential was wrong, and neither do we.
            flow === "signIn"
            ? "That email and password don't match an account."
            : "We couldn't create that account. It may already exist, or the password may be shorter than 8 characters.",
      );
      setPending(false);
    }
  }

  return (
    // The same desk the landing is ruled on, at its faintest: this is the
    // door between the two, and the sheet should not end at the doorway.
    <PageSurface>
      <div className="flex min-h-screen flex-col bg-transparent px-6 py-16 sm:px-10">
        <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-10">
          <header className="flex flex-col gap-3 border-l border-rule pl-6">
            <Link
              href="/"
              className="self-start font-serif text-4xl lowercase tracking-tight text-ink-strong transition-opacity hover:opacity-75"
            >
              margin
            </Link>
            {/* The sentence, not the wordmark, is what this page is called:
                it says which of the two things you are here to do, and it
                changes when you switch. The wordmark above it stays what it
                looks like — the way home. Sized as it was drawn; a heading
                level is not a type scale. */}
            <h1 className="font-serif text-base leading-relaxed text-ink-muted">
              {flow === "signIn"
                ? "Pick up where your lab left off."
                : "Start reading with your lab."}
            </h1>
          </header>

          <form
            onSubmit={handleSubmit}
            className={`${cardClass} flex flex-col gap-5`}
          >
            {/* The name field stays in the tree and folds open when the form
                becomes a sign-up: rows and the swallowed flex gap ease
                together, so the switch is a fold rather than a jump. The
                input is disabled while folded — out of the tab order and out
                of the submitted form. */}
            <div
              aria-hidden={flow !== "signUp"}
              className={
                "grid motion-safe:transition-[grid-template-rows,opacity,margin] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)] " +
                (flow === "signUp"
                  ? "grid-rows-[1fr] opacity-100"
                  : "-mt-5 grid-rows-[0fr] opacity-0")
              }
            >
              <div className="overflow-hidden">
                <div className="flex flex-col gap-2 p-px">
                  <label htmlFor="name" className={labelClass}>
                    Name
                  </label>
                  <input
                    id="name"
                    name="name"
                    type="text"
                    autoComplete="name"
                    placeholder="Ada Lovelace"
                    disabled={flow !== "signUp"}
                    className={inputClass}
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor="email" className={labelClass}>
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@university.edu"
                className={inputClass}
              />
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor="password" className={labelClass}>
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                minLength={8}
                autoComplete={
                  flow === "signIn" ? "current-password" : "new-password"
                }
                placeholder="At least 8 characters"
                className={inputClass}
              />
            </div>

            {error !== null && (
              <p role="alert" className={`${errorClass} pop-in`}>
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={pending}
              className={`${primaryButtonClass} tap-target`}
            >
              {pending
                ? "One moment…"
                : flow === "signIn"
                  ? "Sign in"
                  : "Create account"}
            </button>
          </form>

          <p className="font-sans text-sm text-ink-muted">
            {flow === "signIn"
              ? "New to Margin? "
              : "Already have an account? "}
            <button
              type="button"
              className={`${linkButtonClass} tap-target`}
              onClick={switchFlow}
            >
              {flow === "signIn" ? "Create an account" : "Sign in"}
            </button>
          </p>
        </main>

        <footer className="mx-auto w-full max-w-sm pt-10 font-sans text-xs leading-relaxed text-ink-faint">
          Margin never tracks what you read. The only record it keeps is what
          you choose to write down.
        </footer>
      </div>
    </PageSurface>
  );
}
