"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PageSurface } from "@/app/(marketing)/_components/hero-surface";
import {
  clearRehydratedSession,
  isRecoveryDestination,
} from "@/lib/auth/session-recovery";
import {
  cardClass,
  errorClass,
  eyebrowClass,
  inputClass,
  labelClass,
  linkButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/lib/ui";

/**
 * Three ways through this door, and which of them exist is a build-time fact.
 *
 * `link` is the one the product wants you to take: a member's first entry
 * should be click link → reading the paper, with no password ceremony. The two
 * password flows stay because a deployment with no Resend key still has to let
 * a PI in, and because some people would simply rather have a password.
 */
type Flow = "link" | "signIn" | "signUp";

/**
 * The browser cannot read Convex deployment env, so it is told separately
 * whether the deployment has the keys. These are inlined by Next at build
 * time, which is why they are spelled out rather than looked up — set neither
 * and this page is exactly the password form it has always been.
 */
const GOOGLE_ENABLED = process.env.NEXT_PUBLIC_AUTH_GOOGLE === "1";
const EMAIL_ENABLED = process.env.NEXT_PUBLIC_AUTH_EMAIL === "1";

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
  if (value === "signup") {
    return "signUp";
  }
  // The link is the front door wherever it exists; a deployment without mail
  // falls back to the form it has always had.
  return EMAIL_ENABLED ? "link" : "signIn";
}

/** An invite code is eight of an unambiguous alphabet; anything else isn't one. */
function inviteFromParam(value: string | null): string | null {
  return value !== null && /^[A-Za-z0-9]{1,16}$/.test(value) ? value : null;
}

/**
 * Google's mark, drawn rather than fetched.
 *
 * The four brand colours are the one place a foreign palette is allowed onto
 * this page — a recoloured G is not a G, and a button people don't recognise
 * is a button they don't press. Held to 16px so it reads as a stamp on the
 * label rather than a splash of somebody else's brand on the notebook.
 */
function GoogleMark() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 18 18"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

/** A ruled line broken by a pencilled word, the way a notebook separates two things. */
function OrRule() {
  return (
    <div className="flex items-center gap-4" aria-hidden="true">
      <span className="h-px flex-1 bg-rule" />
      <span className="font-sans text-[10px] uppercase tracking-[0.18em] text-ink-faint">
        or
      </span>
      <span className="h-px flex-1 bg-rule" />
    </div>
  );
}

export default function SignInPage() {
  const { signIn, signOut } = useAuthActions();
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
  const [recoveryPending, setRecoveryPending] = useState(() =>
    isRecoveryDestination(searchParams),
  );
  // Set once a sign-in link is on its way: the card becomes the answer to
  // "did it send?" rather than a form waiting to be filled in again.
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null);

  // An emailed invitation lands here when its recipient has no session yet.
  // The code is carried through the sign-in and redeemed on the other side by
  // the app shell — this page only has to not lose it.
  const invite = inviteFromParam(searchParams.get("invite"));
  const destination = invite === null ? "/app" : `/app?invite=${invite}`;

  // Arriving from the error boundary, this page is handed the very session it
  // was navigated here to escape: a failed `auth:signOut` never got its
  // clearing `Set-Cookie` written, so the server provider read the surviving
  // cookie and the client rehydrated the dead token from it. Signing that back
  // out takes two agreeing signals: the flag in the URL, and the one-shot
  // marker the boundary left in this tab's `sessionStorage` a navigation ago.
  // The flag by itself would be an invitation — it rides on a public URL any
  // outside page can link to, and `/signin?reauth=1` is admitted by the
  // middleware on purpose — so a reader with a live session sent here by
  // somebody else spends no marker and keeps their session. The ref is what
  // makes it once, not once per effect run: this is a request rather than a
  // subscription, and Strict Mode would otherwise fire two of them. Recovery
  // starts pending on the first render so no new sign-in can get ahead of this
  // cleanup and then be erased by its late sign-out — and it settles either
  // way, so a visit with no marker leaves the form usable rather than stuck.
  const clearedRehydratedSession = useRef(false);
  useEffect(() => {
    if (clearedRehydratedSession.current) {
      return;
    }
    clearedRehydratedSession.current = true;
    void clearRehydratedSession({
      searchParams,
      storage: () => window.sessionStorage,
      signOut,
    }).finally(() => {
      setRecoveryPending(false);
    });
  }, [searchParams, signOut]);

  function switchFlow(next: Flow) {
    setFlow(next);
    setError(null);
    setLinkSentTo(null);
    // history rather than the router: the mode is a detail of this screen, and
    // a re-render is not worth a round trip for the RSC payload. Keeps a
    // refresh — and anything the reader copies out of the address bar — on the
    // form they were actually looking at.
    const params = new URLSearchParams();
    if (next === "signUp") {
      params.set("flow", "signup");
    }
    if (invite !== null) {
      params.set("invite", invite);
    }
    const query = params.toString();
    window.history.replaceState(null, "", query ? `/signin?${query}` : "/signin");
  }

  async function handleGoogle() {
    if (recoveryPending) {
      return;
    }
    setError(null);
    setPending(true);
    try {
      // Full-page redirect out to Google; `redirectTo` is where its callback
      // comes back to, which is how the invite code survives the round trip.
      await signIn("google", { redirectTo: destination });
    } catch (caught) {
      setError(
        caught instanceof Error && /not configured/i.test(caught.message)
          ? "Google sign-in isn't set up on this deployment yet."
          : isServiceFailure(caught)
          ? "We couldn't reach Google just then. Try again in a moment."
          : "Google sign-in didn't go through.",
      );
      setPending(false);
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (recoveryPending) {
      return;
    }
    setError(null);
    setPending(true);

    const formData = new FormData(event.currentTarget);
    // Normalized here because the sign-in link provider stores the address as
    // given: `Ada@Uni.edu` and `ada@uni.edu` would otherwise be two accounts.
    const email = String(formData.get("email") ?? "")
      .trim()
      .toLowerCase();

    try {
      if (flow === "link") {
        await signIn("sign-in-link", { email, redirectTo: destination });
        setLinkSentTo(email);
        setPending(false);
        return;
      }

      formData.set("email", email);
      formData.set("flow", flow);
      await signIn("password", formData);
      router.push(destination);
    } catch (caught) {
      setError(
        isServiceFailure(caught)
          ? "We couldn't reach the sign-in service — that's on us, not on what you typed. Try again in a moment."
          : flow === "link"
            ? "We couldn't send a link to that address."
            : // Convex Auth deliberately does not say which half of the
              // credential was wrong, and neither do we.
              flow === "signIn"
              ? "That email and password don't match an account."
              : "We couldn't create that account. It may already exist, or the password may be shorter than 8 characters.",
      );
      setPending(false);
    }
  }

  const wantsPassword = flow !== "link";
  const actionPending = pending || recoveryPending;

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
              {invite !== null
                ? "You've been invited to a lab. Sign in and Margin will take you straight there."
                : flow === "signUp"
                  ? "Start reading with your lab."
                  : "Pick up where your lab left off."}
            </h1>
          </header>

          {linkSentTo !== null ? (
            <section
              aria-live="polite"
              className={`${cardClass} pop-in flex flex-col gap-4`}
            >
              <span className={eyebrowClass}>Check your inbox</span>
              <p className="font-serif text-base leading-relaxed text-ink">
                A sign-in link is on its way to{" "}
                <span className="text-ink-strong">{linkSentTo}</span>. Open it
                and you&rsquo;re in — the link works from any device, for the
                next hour.
              </p>
              <p className="font-sans text-xs leading-relaxed text-ink-faint">
                Nothing yet? Give it a minute, then look in spam.
              </p>
              <button
                type="button"
                className={`${linkButtonClass} tap-target self-start`}
                onClick={() => {
                  setLinkSentTo(null);
                  setError(null);
                }}
              >
                Use a different address
              </button>
            </section>
          ) : (
            <div className="flex flex-col gap-6">
              {GOOGLE_ENABLED && (
                <>
                  <button
                    type="button"
                    disabled={actionPending}
                    onClick={handleGoogle}
                    className={`${secondaryButtonClass} tap-target w-full gap-2.5`}
                  >
                    <GoogleMark />
                    Continue with Google
                  </button>
                  <OrRule />
                </>
              )}

              <form
                onSubmit={handleSubmit}
                className={`${cardClass} flex flex-col gap-5`}
              >
                {/* The name and password fields stay in the tree and fold
                    open when the form needs them: rows and the swallowed flex
                    gap ease together, so switching mode is a fold rather than
                    a jump. A folded input is disabled — out of the tab order
                    and out of the submitted form. */}
                <Fold open={flow === "signUp"}>
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
                </Fold>

                <div className="flex flex-col gap-2">
                  <label htmlFor="email" className={labelClass}>
                    Email
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    required
                    autoFocus
                    autoComplete="email"
                    placeholder="you@university.edu"
                    className={inputClass}
                  />
                </div>

                <Fold open={wantsPassword}>
                  <label htmlFor="password" className={labelClass}>
                    Password
                  </label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    required={wantsPassword}
                    minLength={8}
                    autoComplete={
                      flow === "signIn" ? "current-password" : "new-password"
                    }
                    placeholder="At least 8 characters"
                    disabled={!wantsPassword}
                    className={inputClass}
                  />
                </Fold>

                {error !== null && (
                  <p role="alert" className={`${errorClass} pop-in`}>
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={actionPending}
                  className={`${primaryButtonClass} tap-target`}
                >
                  {pending
                    ? "One moment…"
                    : flow === "link"
                      ? "Email me a sign-in link"
                      : flow === "signIn"
                        ? "Sign in"
                        : "Create account"}
                </button>

                {flow === "link" && (
                  <p className="font-sans text-xs leading-relaxed text-ink-faint">
                    No password to make up, and none to forget. If you already
                    have an account the link signs you into it.
                  </p>
                )}
              </form>
            </div>
          )}

          {/* The way to the other flows, kept as a sentence rather than a row
              of tabs: this page has one thing it wants you to do and the rest
              are asides. */}
          <p className="font-sans text-sm leading-relaxed text-ink-muted">
            {flow === "link" ? (
              <>
                Prefer a password?{" "}
                <button
                  type="button"
                  className={`${linkButtonClass} tap-target`}
                  onClick={() => switchFlow("signIn")}
                >
                  Sign in
                </button>
                {" or "}
                <button
                  type="button"
                  className={`${linkButtonClass} tap-target`}
                  onClick={() => switchFlow("signUp")}
                >
                  create an account
                </button>
                .
              </>
            ) : (
              <>
                {flow === "signIn"
                  ? "New to Margin? "
                  : "Already have an account? "}
                <button
                  type="button"
                  className={`${linkButtonClass} tap-target`}
                  onClick={() =>
                    switchFlow(flow === "signIn" ? "signUp" : "signIn")
                  }
                >
                  {flow === "signIn" ? "Create an account" : "Sign in"}
                </button>
                {EMAIL_ENABLED && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className={`${linkButtonClass} tap-target`}
                      onClick={() => switchFlow("link")}
                    >
                      Email me a link instead
                    </button>
                  </>
                )}
              </>
            )}
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

/**
 * A field that folds out of the form instead of appearing in it.
 *
 * `grid-template-rows` from 0fr to 1fr is the only way to ease to a height the
 * content decides; the negative margin cancels the parent's flex gap while
 * closed so the rows above and below meet cleanly. Both are motion-safe, so
 * reduced motion gets the same layout without the travel.
 */
function Fold({
  open,
  children,
}: {
  open: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      aria-hidden={!open}
      className={
        "grid motion-safe:transition-[grid-template-rows,opacity,margin] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)] " +
        (open ? "grid-rows-[1fr] opacity-100" : "-mt-5 grid-rows-[0fr] opacity-0")
      }
    >
      <div className="overflow-hidden">
        <div className="flex flex-col gap-2 p-px">{children}</div>
      </div>
    </div>
  );
}
