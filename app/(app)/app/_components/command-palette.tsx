"use client";

import { rankCommands } from "@/lib/command";
import { Dialog } from "@base-ui/react/dialog";
import { useAuthActions } from "@convex-dev/auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * ⌘K — the way to the rest of the app without reaching for the rail.
 *
 * Mounted once in the `/app` layout, so it is available from every screen
 * including the reader, where the sidebar is the first thing a reader wants
 * out of the way. In PR 0 the list is exactly the rail's own destinations plus
 * the sign-out the rail already offers: the palette earns its keep by being a
 * second, faster path to what exists, not by being the only path to something
 * new. Later PRs add the verbs (open a paper, start a session, jump to a note)
 * — the shape here is built for a list that grows, which is why the matching
 * and ranking live in `lib/command.ts` under test rather than inline.
 *
 * The keyboard contract is the ARIA combobox one: the text field keeps focus
 * the whole time and `aria-activedescendant` names the row the arrows are on,
 * so the caret never leaves the input and a screen reader still hears each row
 * as it is passed. Moving real focus onto the rows instead would mean every
 * keystroke after an arrow key went somewhere the typing could not continue.
 */

type Command = {
  label: string;
  /** Shown, muted, at the end of the row — where the command takes you. */
  section: string;
  /** Matched but never shown: the words people reach for that aren't the label. */
  keywords: string[];
  /** Where a Navigate command goes. Present so the row can be prefetched. */
  href?: string;
  /** Not undoable from a keystroke. `rankCommands` never lets it win a tie. */
  dangerous?: boolean;
  run: () => void | Promise<void>;
};

export function CommandPalette() {
  const router = useRouter();
  const { signOut } = useAuthActions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();

  const commands = useMemo<Command[]>(
    () => [
      {
        label: "Go to lab home",
        section: "Navigate",
        keywords: ["overview", "dashboard", "start"],
        href: "/app",
        run: () => router.push("/app"),
      },
      {
        label: "Go to Library",
        section: "Navigate",
        keywords: ["papers", "reading", "pdf"],
        href: "/app/library",
        run: () => router.push("/app/library"),
      },
      {
        label: "Go to Sessions",
        section: "Navigate",
        keywords: ["journal club", "meetings", "schedule"],
        href: "/app/sessions",
        run: () => router.push("/app/sessions"),
      },
      {
        // The same two calls the rail makes, in the same order — the palette
        // is another way to press the same control, not a second
        // implementation of signing out. That includes the document
        // navigation: see the rail for why signing out must not be a
        // `router.push`.
        label: "Sign out",
        section: "Account",
        keywords: ["log out", "logout", "leave"],
        // The only row here you cannot press your way back from. `s` scores
        // the same on this and on "Go to Sessions", and the shorter label used
        // to settle it — so ⌘K, s, Enter ended the session. See `rankCommands`.
        dangerous: true,
        run: async () => {
          await signOut();
          window.location.assign("/signin");
        },
      },
    ],
    [router, signOut],
  );

  const results = useMemo(
    () => rankCommands(query, commands),
    [query, commands],
  );
  const active = results[activeIndex];

  // The one global listener in the app. On `window` rather than on a wrapper
  // element so it fires wherever focus happens to be — including inside the
  // PDF canvas, which is exactly where someone is when they want it.
  //
  // Re-subscribed whenever `open` changes rather than reading the flag through
  // a functional updater, because opening is not just a flag flip: the field
  // and the highlight have to be cleared in the same commit. `setOpen(c => !c)`
  // cannot tell the two directions apart from outside, and telling them apart
  // *inside* the updater would mean calling other setters from it — updaters
  // have to be pure, and React is entitled to run them twice. One listener,
  // swapped twice per use of the palette, costs nothing.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "k") return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      // Both browser and OS have their own ⌘K/Ctrl+K in places (search bar,
      // kill-line in a text field), and taking it is the point.
      event.preventDefault();
      // A held ⌘K auto-repeats, and every repeat used to be another toggle:
      // whether the palette ended up open depended on when the fingers came
      // off the keys. The shortcut is a door, not a switch — only the first
      // press of a hold means anything. After `preventDefault`, not before:
      // the repeats are still ours to swallow, or holding the key would hand
      // the browser its own ⌘K back mid-hold.
      if (event.repeat) return;
      if (open) {
        setOpen(false);
        return;
      }
      // Every open starts from a blank field, and this is the only place that
      // can say so. The dialog has no `Dialog.Trigger`, so Base UI never opens
      // it and never reports an opening — a controlled `open` prop turning true
      // is not an event it raises. A reset hung off `onOpenChange(true, …)` is
      // code that never runs, and the palette would reopen still holding the
      // last thing typed into it: `sign` + Escape + ⌘K would come back with one
      // row showing and "Sign out" highlighted, one Enter away.
      //
      // Batched with `setOpen` into a single commit, so no stale query is ever
      // painted — including under reduced motion, where there is no entrance
      // fade to hide a frame behind.
      setQuery("");
      setActiveIndex(0);
      setOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // The rail's links carry `prefetch`, so a destination reached from there is
  // usually already in the router cache; the palette's `router.push` had
  // nothing behind it, and the same route arrived wearing a skeleton depending
  // on which way you asked for it. So the highlighted row warms its own
  // destination — by the time the arrow key stops moving, the page is on its
  // way. `router.prefetch` is idempotent and cached, so re-running this as the
  // highlight walks a list costs one entry per route, once.
  useEffect(() => {
    if (!open) return;
    if (active?.href === undefined) return;
    router.prefetch(active.href);
  }, [open, active, router]);

  // `aria-activedescendant` does not scroll the way real focus does — the
  // browser has no idea the highlight moved — so the list has to be told.
  // `nearest` keeps the list still while the highlight is already in view.
  useEffect(() => {
    listRef.current?.children[activeIndex]?.scrollIntoView({
      block: "nearest",
    });
  }, [activeIndex, results]);

  function runCommand(command: Command) {
    // Closed first, and synchronously: the dialog returns focus to whatever
    // held it before it opened, and doing that before a navigation starts
    // means the restore lands on a page that is still there.
    setOpen(false);
    void command.run();
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // `next` is only ever `false` here. With no `Dialog.Trigger` the dialog
        // has no way to open itself, so everything Base UI reports through this
        // is a *closing*: Escape, an outside press, a close press. The opening —
        // and the reset it owes — belongs to the keydown listener above, which
        // is the only thing that can raise `open`.
        //
        // Note also what this deliberately does not do: clear the query on the
        // way out. The popup spends 120ms fading, and a list that emptied itself
        // first would be the last thing seen of it.
        setOpen(next);
      }}
    >
      <Dialog.Portal>
        {/* The page held back, same wash and same blur as the confirm dialog. */}
        <Dialog.Backdrop
          className={
            "fixed inset-0 z-50 bg-[color-mix(in_oklab,var(--page)_60%,transparent)] " +
            "backdrop-blur-[2px] transition-opacity duration-[var(--dur-exit)] ease-out " +
            "motion-reduce:transition-none " +
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
          }
        />
        {/*
          High on the page rather than centred: the palette is read top-down
          from a field the eye is already looking for, and a centred sheet
          moves that field to wherever the list happens to end.

          Placed with `inset-x-0` + `mx-auto` and no transform at all. The
          entrance is opacity-only — 120ms, the app's short clock, because the
          surface is summoned by a keystroke and the whole reason the rest of
          the app animates entrances (covering the time a pointer spends
          travelling) does not apply. It stops short of appearing from nowhere,
          which at this size would read as a flash.
        */}
        <Dialog.Popup
          initialFocus={inputRef}
          className={
            "fixed inset-x-0 top-[12vh] z-50 mx-auto flex w-[calc(100%-2rem)] max-w-lg " +
            "flex-col overflow-hidden rounded-md border border-rule bg-surface " +
            "shadow-[var(--shadow-sheet)] outline-none " +
            "transition-opacity duration-[var(--dur-exit)] ease-out " +
            "motion-reduce:transition-none " +
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
          }
        >
          {/* The sheet has no visible heading — the placeholder does that job
              for anyone looking at it — but a dialog still needs a name. */}
          <Dialog.Title className="sr-only">Commands</Dialog.Title>

          {/*
            The field is inset by the same 1.5 the list below it is, rather
            than running to the sheet's edges, and that padding is load-bearing
            rather than decorative: the app states its focus ring once, in
            `globals.css`, as an unlayered `:focus-visible` rule — which outranks
            any `outline-none` utility no matter how specific, because unlayered
            styles beat layered ones. So the ring on this field is going to be
            drawn whatever the component says, and the only question is whether
            there is room for it. There is: 6px of padding against 2px of offset
            plus 2px of ring. Full-bleed, it was clipped by the sheet's own
            `overflow-hidden` into a stray accent bar under the field.

            It also lands the placeholder on exactly the same x as the labels
            below it, which is what makes the list read as one column.
          */}
          <div className="border-b border-rule p-1.5">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                // Any keystroke re-ranks the list, so the highlight goes back
                // to the top: it belongs to the best match, not to a position.
                setActiveIndex(0);
              }}
              // Chrome, not content: this is a control, not something written.
              className="w-full rounded-sm bg-transparent px-2.5 py-2.5 font-sans text-sm text-ink placeholder:text-ink-faint"
              placeholder="Search commands…"
              aria-label="Search commands"
              role="combobox"
              aria-expanded
              aria-controls={`${baseId}-list`}
              aria-autocomplete="list"
              aria-activedescendant={
                active === undefined
                  ? undefined
                  : `${baseId}-option-${activeIndex}`
              }
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(event) => {
                if (results.length === 0) return;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex((i) => (i + 1) % results.length);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex(
                    (i) => (i - 1 + results.length) % results.length,
                  );
                } else if (event.key === "Enter" && active !== undefined) {
                  event.preventDefault();
                  runCommand(active);
                }
                // Escape is left alone: it is the dialog's, and Base UI has it.
              }}
            />
          </div>

          <ul
            ref={listRef}
            id={`${baseId}-list`}
            role="listbox"
            aria-label="Commands"
            className="max-h-[min(60vh,20rem)] overflow-y-auto p-1.5"
          >
            {results.map((command, index) => (
              <li
                key={command.label}
                id={`${baseId}-option-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                // Same highlight grammar as the select's list: one attribute,
                // one sunken row, whether it was reached by arrow or pointer.
                data-highlighted={index === activeIndex ? "" : undefined}
                className={
                  "pressable flex items-baseline gap-3 rounded-sm px-2.5 py-2 " +
                  "font-sans text-sm text-ink data-[highlighted]:bg-surface-sunken"
                }
                onPointerMove={() => {
                  if (index !== activeIndex) setActiveIndex(index);
                }}
                onClick={() => runCommand(command)}
              >
                <span>{command.label}</span>
                <span className="ml-auto shrink-0 text-xs text-ink-faint">
                  {command.section}
                </span>
              </li>
            ))}
          </ul>

          {results.length === 0 && (
            <p className="px-4 py-6 text-center font-sans text-sm text-ink-faint">
              Nothing here by that name.
            </p>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
