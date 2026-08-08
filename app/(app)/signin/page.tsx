"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  errorClass,
  inputClass,
  labelClass,
  linkButtonClass,
  primaryButtonClass,
} from "@/lib/ui";

type Flow = "signIn" | "signUp";

export default function SignInPage() {
  const { signIn } = useAuthActions();
  const router = useRouter();
  const [flow, setFlow] = useState<Flow>("signIn");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const formData = new FormData(event.currentTarget);
    formData.set("flow", flow);

    try {
      await signIn("password", formData);
      router.push("/app");
    } catch {
      // Convex Auth deliberately does not say which half of the credential
      // was wrong, and neither do we.
      setError(
        flow === "signIn"
          ? "That email and password don't match an account."
          : "We couldn't create that account. It may already exist, or the password may be shorter than 8 characters.",
      );
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-page px-6 py-16 sm:px-10">
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-10">
        <header className="flex flex-col gap-3 border-l border-rule pl-6">
          <Link
            href="/"
            className="font-serif text-4xl lowercase tracking-tight text-ink-strong"
          >
            margin
          </Link>
          <p className="font-serif text-base leading-relaxed text-ink-muted">
            {flow === "signIn"
              ? "Pick up where your lab left off."
              : "Start reading with your lab."}
          </p>
        </header>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          {flow === "signUp" && (
            <div className="flex flex-col gap-2">
              <label htmlFor="name" className={labelClass}>
                Name
              </label>
              <input
                id="name"
                name="name"
                type="text"
                autoComplete="name"
                placeholder="Ada Lovelace"
                className={inputClass}
              />
            </div>
          )}

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
            <p role="alert" className={errorClass}>
              {error}
            </p>
          )}

          <button type="submit" disabled={pending} className={primaryButtonClass}>
            {pending
              ? "One moment…"
              : flow === "signIn"
                ? "Sign in"
                : "Create account"}
          </button>
        </form>

        <p className="font-sans text-sm text-ink-muted">
          {flow === "signIn" ? "New to Margin? " : "Already have an account? "}
          <button
            type="button"
            className={linkButtonClass}
            onClick={() => {
              setFlow(flow === "signIn" ? "signUp" : "signIn");
              setError(null);
            }}
          >
            {flow === "signIn" ? "Create an account" : "Sign in"}
          </button>
        </p>
      </main>

      <footer className="mx-auto w-full max-w-sm pt-10 font-sans text-xs leading-relaxed text-ink-faint">
        Margin never tracks what you read. The only record it keeps is what you
        choose to write down.
      </footer>
    </div>
  );
}
