"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  errorClass,
  eyebrowClass,
  inputClass,
  labelClass,
  secondaryButtonClass,
  selectClass,
  skeletonClass,
} from "@/lib/ui";
import { useAction, useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { useEffect, useRef, useState } from "react";
import { ConfirmAction } from "./confirm-action";
import { readableError } from "./errors";
import type { LabSummary } from "./lab-provider";

/**
 * Keep Zotero.
 *
 * The strategy document is blunt about this (`docs/STRATEGY.md:121`): Margin
 * does not rebuild citation management, and "keep using Zotero" is the pitch
 * rather than a concession. So this section is deliberately small — a key, a
 * library, an optional collection, and a button — and everything it says is
 * about what Margin will do with somebody else's library rather than what
 * Margin would like to become.
 *
 * ## Why the key never reaches React state
 *
 * The same bargain `slack-delivery.tsx` makes with a webhook URL, for the same
 * reason. The field is read off a ref at submit and the input is cleared; the
 * key is not a value this component holds, it is a value passing through it.
 * Once it is on the server there is no query that will hand it back — the
 * status query answers *when* it was connected, never *what* it is — so the
 * only place the string ever exists in a browser is the field the member
 * pasted it into.
 *
 * ## Why a paged sync gets a paged sentence
 *
 * A run walks a bounded page and stops, on purpose. A UI that says "Synced!"
 * after 25 of a member's 4,000 papers is lying in the way that costs trust
 * later — so progress is always "N of about M", and the button says whether
 * there is more. A partial import that announces itself is a product being
 * careful. A partial import that pretends to be complete is a bug the member
 * finds on their own, a week later.
 *
 * Unlike Slack, this is one member's link rather than the lab's, and
 * `api.zotero.status` answers only about the caller's own — so every member
 * sees this section, and each of them sees their own answer in it.
 */
export function ZoteroSync({ lab }: { lab: LabSummary }) {
  const status = useQuery(api.zotero.status, { labId: lab._id });

  if (status === undefined) {
    return (
      <section className="flex flex-col gap-5">
        <h2 className={eyebrowClass}>Zotero</h2>
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
      <h2 className={eyebrowClass}>Zotero</h2>

      <p className="max-w-prose font-serif text-base leading-relaxed text-ink-muted">
        {status.connected
          ? "Papers you file in Zotero turn up on this lab’s shelf, with their PDFs where Zotero is holding them. Margin reads; it never writes back."
          : "Point Margin at your Zotero — a whole library, or one collection inside it — and it keeps the shelf topped up from there. Read-only, one direction: the library stays yours."}
      </p>

      {status.lastSyncFailed !== null && (
        <p role="status" className={`${errorClass} max-w-prose`}>
          {/*
            403 and 404 are the two that need the member. A key that was
            deleted, or one that never reached this library — either way no
            amount of waiting fixes it, so the sentence asks for a new key
            rather than promising to retry. Everything else that gets this far
            is a bad afternoon at api.zotero.org, and `permanentStatus` has
            already filtered those out.
          */}
          {status.lastSyncFailed.statusCode === 403 ||
          status.lastSyncFailed.statusCode === 404
            ? "Zotero turned that key down. It may have been deleted, or it may not reach this library any more — paste a new one."
            : "The last sync did not go through. Margin will try again within the hour."}
        </p>
      )}

      {status.connected ? (
        <Linked labId={lab._id} status={status} />
      ) : (
        <ConnectForm labId={lab._id} />
      )}
    </section>
  );
}

/**
 * What `api.zotero.status` answers, named once so the file's parts agree.
 *
 * Written out rather than inferred because this file is the only consumer of
 * that query and a rename on the server should break here loudly.
 */
type ZoteroStatus = {
  connected: boolean;
  libraryName: string | null;
  collectionName: string | null;
  scopeAccepted: boolean;
  lastSyncAt: number | null;
  lastSyncFailed: { at: number; statusCode: number } | null;
  progress: { checked: number; total: number; imported: number } | null;
  lastImported: number | null;
};

/** Step one: a key, and where to make one. */
function ConnectForm({ labId }: { labId: Id<"labs"> }) {
  const connect = useAction(api.zotero.connect);
  const field = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex max-w-md flex-col gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        const input = field.current;
        const apiKey = input?.value.trim() ?? "";
        if (apiKey === "" || pending) return;
        setPending(true);
        setError(null);
        try {
          await connect({ labId, apiKey });
          // Cleared on the way out, never held in state on the way in.
          if (input !== null) input.value = "";
        } catch (caught) {
          setError(readableError(caught, "That key did not work."));
        } finally {
          setPending(false);
        }
      }}
    >
      <label className={labelClass} htmlFor="zotero-key">
        API key
      </label>
      <input
        ref={field}
        id="zotero-key"
        name="apiKey"
        // A password field, because a key pasted in a shared office is still a
        // key, and because it keeps the browser from offering to remember it.
        type="password"
        required
        autoComplete="off"
        spellCheck={false}
        className={inputClass}
        placeholder="P9NiFoyLeZu2bZNvvuQPDWsd"
        disabled={pending}
      />
      <p className="font-sans text-xs leading-relaxed text-ink-faint">
        zotero.org &rarr; Settings &rarr; Feeds/API &rarr; Create new private
        key. Margin only needs read access, and refuses a key that can write.
      </p>

      {error !== null && (
        <p role="alert" className={`${errorClass} pop-in`}>
          {error}
        </p>
      )}

      <button
        type="submit"
        className={`${secondaryButtonClass} self-start`}
        disabled={pending}
      >
        {pending ? "Checking…" : "Connect"}
      </button>
    </form>
  );
}

/**
 * What is being watched, said in one line.
 *
 * A library with no collection named is a finished answer rather than an
 * unfinished one: `connect` points the link at the member's own library, and
 * the sweep walks all of it. So the whole-library case gets a sentence of its
 * own instead of an empty space that reads like a step still to do.
 */
function scopeLine(status: ZoteroStatus): string {
  if (status.libraryName === null) {
    return "Everything in your own Zotero library.";
  }
  return status.collectionName === null
    ? `Everything in ${status.libraryName}.`
    : `${status.collectionName} — ${status.libraryName}.`;
}

/** What is linked, how far along it is, how to narrow it, and how to stop. */
function Linked({ labId, status }: { labId: Id<"labs">; status: ZoteroStatus }) {
  const disconnect = useMutation(api.zotero.disconnect);
  const acceptScope = useMutation(api.zotero.acceptScope);
  /**
   * The picker is open on arrival only until the member has answered it, and
   * it stays open across the library write. That second half is the load-
   * bearing part: choosing a library *is* a `chooseScope`, so a panel whose
   * visibility was read off the status query would close itself the moment the
   * library landed — and the collection step lives on the far side of that
   * write, so nobody would ever see it.
   *
   * `scopeAccepted` rather than `libraryName === null`, which is what this
   * asked before and which is not the same question. A member who is happy
   * with their whole library never names one, so the old test stayed true
   * forever: the panel re-opened on every settings visit, spending two
   * requests to api.zotero.org each time to re-offer a question that had been
   * answered — the thing `ScopeForm`'s own doc says a settings page must not
   * do. Done now writes that answer down, and "Change what syncs" is how it is
   * re-opened by somebody who means to.
   */
  const [choosing, setChoosing] = useState(!status.scopeAccepted);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex max-w-md flex-col gap-4">
      <p className="font-sans text-sm text-ink">{scopeLine(status)}</p>

      {status.progress !== null && (
        // "About", because `Total-Results` was true when the walk started and
        // the member has been adding papers since. A number that turns out to
        // be off by three is fine; a number that claimed to be exact and was
        // off by three is the one that gets reported as a bug.
        <p className="font-sans text-xs text-ink-faint">
          {`Synced ${status.progress.checked} of about ${status.progress.total} — the rest arrives over the next few checks.`}
        </p>
      )}

      {choosing ? (
        <ScopeForm
          labId={labId}
          onDone={() => {
            setChoosing(false);
            // Closed first, recorded after. The panel shutting is the answer
            // to the press, and a member who loses the write — offline, a tab
            // closed on the way out — is asked once more rather than left
            // looking at a panel that did not respond.
            void acceptScope({ labId }).catch(() => undefined);
          }}
        />
      ) : (
        <button
          type="button"
          className={`${secondaryButtonClass} self-start`}
          onClick={() => setChoosing(true)}
        >
          Change what syncs
        </button>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <ZoteroSyncButton labId={labId} />
        <ConfirmAction
          label="Unlink"
          confirmLabel="Unlink Zotero"
          run={async () => {
            setError(null);
            try {
              await disconnect({ labId });
            } catch (caught) {
              setError(readableError(caught, "We couldn't unlink that."));
            }
          }}
        />
      </div>

      <p className="font-sans text-xs leading-relaxed text-ink-faint">
        Unlinking stops the checks and forgets the key. Papers already on the
        shelf stay &mdash; they belong to the lab now.
      </p>

      {error !== null && (
        <p role="alert" className={`${errorClass} pop-in`}>
          {error}
        </p>
      )}
    </div>
  );
}

type Library = { type: "user" | "group"; id: string; name: string };

/**
 * Which library, and optionally which collection inside it.
 *
 * The collection is offered, not demanded. A whole library is a real answer —
 * plenty of people keep one Zotero per project — and `chooseScope` accepts a
 * library with nothing narrowing it. What the offer is for is the other case:
 * a personal Zotero is a decade of half-read PDFs, and pushing all of it onto
 * a shared shelf takes an afternoon to undo. So the narrower choice is put in
 * front of the member rather than left to be discovered.
 *
 * Two round trips rather than one form, because `api.zotero.listCollections`
 * reads the library off the stored link rather than taking one as an argument:
 * choosing a library is itself a `chooseScope` write, and only then is there a
 * library whose collections can be listed. That is the right shape — the
 * server has one answer to "which library is this link pointed at", and it is
 * the stored one, not whatever a form field happened to hold.
 *
 * Both lists come from actions, not queries: they are network calls to
 * somebody else's API, so there is nothing for Convex to keep live. They are
 * fetched once, into state, and re-fetched when the choice changes — which is
 * also why this panel is opened on demand rather than always mounted. A
 * settings page nobody came here to change should not spend a request on
 * api.zotero.org to render.
 */
function ScopeForm({
  labId,
  onDone,
}: {
  labId: Id<"labs">;
  onDone: () => void;
}) {
  const listLibraries = useAction(api.zotero.listLibraries);
  const listCollections = useAction(api.zotero.listCollections);
  const chooseScope = useMutation(api.zotero.chooseScope);

  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [chosen, setChosen] = useState<Library | null>(null);
  const [collections, setCollections] = useState<
    { key: string; name: string }[] | null
  >(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // `cancelled` because this is a network call in an effect and the member
    // can leave the page mid-flight; setting state on the way out is a warning
    // in development and a leak in a long session.
    let cancelled = false;
    listLibraries({ labId })
      .then((result) => {
        if (!cancelled) setLibraries(result.libraries);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(readableError(caught, "Could not reach Zotero."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [labId, listLibraries]);

  async function pickLibrary(library: Library) {
    setPending(true);
    setError(null);
    setCollections(null);
    setChosen(library);
    try {
      await chooseScope({
        labId,
        libraryType: library.type,
        libraryId: library.id,
        libraryName: library.name,
      });
      const result = await listCollections({ labId });
      setCollections(result.collections);
    } catch (caught) {
      setError(readableError(caught, "Could not read that library."));
    } finally {
      setPending(false);
    }
  }

  async function pickCollection(collection: { key: string; name: string }) {
    if (chosen === null) return;
    setPending(true);
    setError(null);
    try {
      await chooseScope({
        labId,
        libraryType: chosen.type,
        libraryId: chosen.id,
        libraryName: chosen.name,
        collectionKey: collection.key,
        collectionName: collection.name,
      });
      onDone();
    } catch (caught) {
      setError(readableError(caught, "Could not save that choice."));
    } finally {
      setPending(false);
    }
  }

  if (libraries === null && error === null) {
    return <div className={`${skeletonClass} h-10 w-full`} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <label className={labelClass} htmlFor="zotero-library">
          Library
        </label>
        <select
          id="zotero-library"
          className={selectClass}
          value={chosen === null ? "" : `${chosen.type}:${chosen.id}`}
          disabled={pending}
          onChange={(event) => {
            const next = (libraries ?? []).find(
              (entry) => `${entry.type}:${entry.id}` === event.target.value,
            );
            if (next !== undefined) void pickLibrary(next);
          }}
        >
          <option value="">Choose a library…</option>
          {(libraries ?? []).map((entry) => (
            <option
              key={`${entry.type}:${entry.id}`}
              value={`${entry.type}:${entry.id}`}
            >
              {entry.name}
            </option>
          ))}
        </select>
        {/* Said before the choice rather than after it: `chooseScope` throws
            the version counter away, because a `Last-Modified-Version` from
            one library means nothing in another. Nothing is lost by that —
            papers already on the shelf are the lab's — but the walk does begin
            again, and somebody idly re-picking should know that first. */}
        <p className="font-sans text-xs leading-relaxed text-ink-faint">
          Changing this starts the walk from the beginning. Papers already on
          the shelf stay where they are.
        </p>
      </div>

      {chosen !== null && (
        <div className="flex flex-col gap-2">
          {/* The waiting block goes as soon as something has gone wrong: a
              shape promising a list that is not coming reads as a hang, and
              the sentence underneath has already said what happened. */}
          {collections === null && error === null && (
            <div className={`${skeletonClass} h-10 w-full`} />
          )}
          {collections !== null &&
            (collections.length === 0 ? (
              <p className="font-sans text-xs leading-relaxed text-ink-faint">
                No collections in this library yet, so all of it syncs. Make
                one in Zotero if you would rather the lab saw only part.
              </p>
            ) : (
              /* The label lives with the control it names rather than above
                 the branch: a library with no collections renders a sentence
                 and no `select`, and a `htmlFor` pointing at an element that
                 was never rendered is a label a screen reader announces with
                 nothing behind it. */
              <>
                <label className={labelClass} htmlFor="zotero-collection">
                  Collection
                </label>
                <select
                  id="zotero-collection"
                  className={selectClass}
                  defaultValue=""
                  disabled={pending}
                  onChange={(event) => {
                    const next = collections.find(
                      (entry) => entry.key === event.target.value,
                    );
                    if (next !== undefined) void pickCollection(next);
                  }}
                >
                  {/*
                    The default is the whole library, and it says so rather
                    than saying "choose one" — the library is already saved as
                    the scope by the time this list renders, so an empty
                    selection is not a missing answer. Picking a collection
                    narrows it; leaving it alone and pressing Done accepts
                    what is true.
                  */}
                  <option value="">Everything in this library</option>
                  {collections.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </>
            ))}
        </div>
      )}

      {/* Outside the picked-a-library guard on purpose: Done writes nothing,
          so it must be reachable in every state. Held hostage to a library
          choice, "Change what syncs" becomes a door with no way back — the
          only exits would be a scope write that restarts the walk (which the
          warning above just advised against) or a page reload. */}
      <button
        type="button"
        className={`${secondaryButtonClass} self-start`}
        disabled={pending}
        onClick={onDone}
      >
        Done
      </button>

      {error !== null && (
        <p role="alert" className={`${errorClass} pop-in`}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Sync now, and an honest sentence about what "now" got through.
 *
 * The button owns its own outcome text rather than reading it off the status
 * query, because the interesting part is the *delta* — the member pressed a
 * thing and wants to know what that press did. `done: false` becomes an
 * invitation to press again rather than an error, which is the difference
 * between a cap that reads as pacing and a cap that reads as a failure.
 */
export function ZoteroSyncButton({ labId }: { labId: Id<"labs"> }) {
  const syncNow = useAction(api.zotero.syncNow);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        className={secondaryButtonClass}
        disabled={pending}
        onClick={async () => {
          if (pending) return;
          setPending(true);
          setOutcome(null);
          try {
            const result = await syncNow({ labId });
            setOutcome(
              result.done && result.imported === 0
                ? "Nothing new."
                : result.done
                  ? `Added ${result.imported}.`
                  : `Added ${result.imported} — there’s more. Press again, or leave it to the hourly check.`,
            );
          } catch (caught) {
            setOutcome(readableError(caught, "That did not go through."));
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? "Syncing…" : "Sync now"}
      </button>
      {outcome !== null && (
        <span role="status" className="font-sans text-xs text-ink-faint">
          {outcome}
        </span>
      )}
    </div>
  );
}
