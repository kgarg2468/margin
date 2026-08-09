"use client";

import { api } from "@/convex/_generated/api";
import { rankCommands, shortcutLabel } from "@/lib/command";
import { formatDate, relativeWhen, statusLabel } from "@/lib/sessions-ui";
import { chipClass, eyebrowClass, keycapClass, skeletonClass } from "@/lib/ui";
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import type { FunctionReturnType } from "convex/server";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
// Aliased: the unqualified name is the DOM event, which the window-level
// shortcut listener below needs.
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { typeStyle } from "../library/[paperId]/read/_components/ontology";
import { useLabs } from "./lab-provider";

/**
 * ⌘K: the card catalogue for a lab.
 *
 * The drawer idea is load-bearing rather than decorative. A palette is a card
 * pulled halfway out of a catalogue — it sits high on the page, it is the only
 * thing you can type into while it is open, and the thing you are on is marked
 * by an accent rule down its left edge. That last one is not a new idiom: it is
 * exactly how the sidebar says which room you are in, and how `errorClass`
 * marks an erratum. One mark, one meaning, used in a third place.
 *
 * Results are grouped and never mixed, because the kinds are not comparable —
 * a paper is a place to go, a note is something a colleague said, a session is
 * a date, a command is a thing the app does. Ranking them against one another
 * would mean inventing a number; grouping them lets the reader apply the one
 * they already have.
 *
 * Commands are the one group that is not a search. They are ranked here, in the
 * browser, by the matcher in `lib/command.ts` — four fixed rows do not need a
 * round trip, and a shortcut that waits on the network is a shortcut people
 * stop reaching for. Everything else is a Convex query. The two answer at
 * different speeds and are allowed to: see `hits` for how the list stays honest
 * about which of its rows the Enter key will actually act on.
 *
 * Nothing here is recorded. The query is a Convex `query`, the input is local
 * state, and the component keeps no history — a list of what someone searched
 * for is a record of what they were thinking about, which is the thing the
 * privacy constitution exists to refuse.
 */

type SearchResults = FunctionReturnType<typeof api.search.everything>;

/** How long a pause counts as "stopped typing". Long enough not to search each keystroke, short enough to feel like it did. */
const DEBOUNCE_MS = 160;

/**
 * One thing the palette can *do*, as against one thing it can find.
 *
 * `keywords` are matched but never shown — the words someone reaches for that
 * are not in the label ("logout" for "Sign out"). `dangerous` marks the row you
 * cannot press your way back from; `rankCommands` never lets one win a tie,
 * which is the rule that keeps ⌘K, `s`, Enter from ending the session.
 */
type Command = {
  label: string;
  keywords?: string[];
  dangerous?: boolean;
  run: () => void | Promise<void>;
};

type CommandPaletteValue = { open: () => void };

const CommandPaletteContext = createContext<CommandPaletteValue | null>(null);

/**
 * The shortcut is global to the authed app, so the palette is mounted once by
 * the shell and reached from anywhere through this. The rail's visible
 * affordance is the only other caller — the shortcut alone would be a feature
 * only the people who already knew about it could find.
 */
export function useCommandPalette(): CommandPaletteValue {
  const value = useContext(CommandPaletteContext);
  if (value === null) {
    throw new Error("useCommandPalette must be used inside the /app layout.");
  }
  return value;
}

/** A hairline lens, drawn to the same weight as the chevron on a select. */
function SearchGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <circle cx="6" cy="6" r="4.25" />
      <path d="M9.2 9.2 12.5 12.5" />
    </svg>
  );
}

/** Every actionable row, in one list, in the order the eye moves down them. */
type Hit =
  | { kind: "command"; key: string; run: () => void | Promise<void> }
  | { kind: "paper"; key: string; href: string }
  | { kind: "annotation"; key: string; href: string }
  | { kind: "session"; key: string; href: string };

/**
 * The flat list the arrow keys walk, commands first.
 *
 * `results` arrives as `null` while what is on screen answers a question the
 * reader has already moved on from — see `current` below. Those rows stay
 * *drawn*, dimmed, but they leave this list, so nothing can select or open
 * them. Commands never do that: they are computed from the field synchronously
 * and are always the answer to what is in it.
 */
function flatten(commands: Command[], results: SearchResults | null): Hit[] {
  const commandHits: Hit[] = commands.map((command) => ({
    kind: "command" as const,
    key: command.label,
    run: command.run,
  }));
  if (results === null) {
    return commandHits;
  }
  return [
    ...commandHits,
    ...results.papers.map((paper) => ({
      kind: "paper" as const,
      key: paper._id,
      href: `/app/library/${paper._id}`,
    })),
    ...results.annotations.map((annotation) => ({
      kind: "annotation" as const,
      key: annotation._id,
      // The reader has no way to be pointed at one note — see `read/page.tsx`,
      // whose only query parameter is the session context. So this opens the
      // paper's margins and lets the rail do the rest, rather than inventing a
      // deep link the reader would ignore.
      href: `/app/library/${annotation.paperId}/read`,
    })),
    ...results.sessions.map((session) => ({
      kind: "session" as const,
      key: session._id,
      href: `/app/sessions/${session._id}`,
    })),
  ];
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open: () => setOpen(true) }), []);

  // Bound here rather than inside the palette so the shortcut exists whether or
  // not the palette is on screen — it is what puts it there. On `window` so it
  // fires wherever focus happens to be, including inside the PDF canvas, which
  // is exactly where someone is when they want it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "k") {
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }
      // Both browser and OS have their own ⌘K/Ctrl+K in places (search bar,
      // kill-line in a text field), and taking it is the point.
      event.preventDefault();
      // A held ⌘K auto-repeats, and every repeat would be another toggle:
      // whether the drawer ended up open would depend on when the fingers came
      // off the keys. The shortcut is a door, not a switch — only the first
      // press of a hold means anything. After `preventDefault`, not before: the
      // repeats are still ours to swallow, or holding the key would hand the
      // browser its own ⌘K back mid-hold.
      if (event.repeat) {
        return;
      }
      setOpen((wasOpen) => !wasOpen);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      {open && <Palette close={() => setOpen(false)} />}
    </CommandPaletteContext.Provider>
  );
}

/**
 * The open drawer.
 *
 * Mounted only while open, which is what makes the rest of it simple: the
 * input starts empty, the subscription starts cold, and closing it genuinely
 * forgets everything rather than keeping a search around in state.
 *
 * That is also the whole of the "every open starts blank" rule, and it is worth
 * naming because the usual way of writing this palette gets it wrong. There is
 * no reset hung off an open event here, because there is no state that survived
 * to be reset — the field cannot come back holding `sign` with "Sign out"
 * marked, one Enter away. Escape, a click on the backdrop and a second ⌘K all
 * take the same door (`close`), and all three unmount.
 */
function Palette({ close }: { close: () => void }) {
  const { currentLab } = useLabs();
  const router = useRouter();
  const { signOut } = useAuthActions();
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /** What the reader is asking for right now, as against what was last asked. */
  const query = text.trim();

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const commands = useMemo<Command[]>(
    () => [
      {
        label: "Go to lab home",
        keywords: ["overview", "dashboard", "start"],
        run: () => router.push("/app"),
      },
      {
        label: "Go to Library",
        keywords: ["papers", "reading", "pdf"],
        run: () => router.push("/app/library"),
      },
      {
        label: "Go to Sessions",
        keywords: ["journal club", "meetings", "schedule"],
        run: () => router.push("/app/sessions"),
      },
      {
        // The same two calls the rail makes, in the same order — the palette is
        // another way to press the same control, not a second implementation of
        // signing out. That includes the document navigation: `clearAuth()`
        // only tells the server to stop trusting us, and the query cache would
        // keep the dead session's `requireUserId` failures subscribed and
        // rethrow them at the next sign-in. A full load destroys the client
        // singleton and the whole poisoned result store. See the rail in
        // `sidebar.tsx` for the long version.
        label: "Sign out",
        keywords: ["log out", "logout", "leave"],
        // The only row here you cannot press your way back from. `s` scores the
        // same on this and on "Go to Sessions", and the shorter label used to
        // settle it — so ⌘K, s, Enter ended the session. See `rankCommands`.
        dangerous: true,
        run: async () => {
          await signOut();
          window.location.assign("/signin");
        },
      },
    ],
    [router, signOut],
  );

  /**
   * The commands that answer the field, best first.
   *
   * Ranked against `query` rather than `debounced`: there is no round trip to
   * wait for, so making these lag the keystroke by 160ms would be latency added
   * for symmetry's sake. An empty query is "no opinion" to `rankCommands`, not
   * "no match" — every command comes back, in the order declared above.
   */
  const commandHits = useMemo(
    () => rankCommands(query, commands),
    [query, commands],
  );

  const results = useQuery(
    api.search.everything,
    currentLab !== null && debounced.length > 0
      ? { labId: currentLab._id, text: debounced }
      : "skip",
  );

  /**
   * The last answer, and — the part that matters — the question it answered.
   *
   * Convex hands back `undefined` while a new argument is in flight, so a list
   * that rendered `results` directly would blink empty on every keystroke. The
   * previous answer stays on screen instead, dimmed, until the next one lands:
   * the drawer does not empty itself while you are still typing into it.
   *
   * But an answer to the previous question must never be *actionable*. Between
   * a keystroke and the response there is a window — the debounce, then the
   * round trip — where the rows on screen belong to text the reader has already
   * moved on from, and an Enter in that window used to open whatever the old
   * top hit was. Landing somewhere you did not ask for is worse than waiting,
   * so the text each response answered is carried alongside it and compared
   * against what is in the field right now. Everything that acts hangs off
   * `current`; only what is *drawn* hangs off `shown`.
   */
  const settled = useRef<{ text: string; results: SearchResults } | null>(null);
  if (results !== undefined && settled.current?.results !== results) {
    settled.current = { text: debounced, results };
  }
  const answered = settled.current;
  const shown = query.length === 0 ? null : (answered?.results ?? null);
  /** The rows on screen are the answer to the text in the field. */
  const current = answered !== null && answered.text === query;
  const searching = query.length > 0 && !current;

  /**
   * Only the rows that will act if you press Enter on them right now.
   *
   * Stale search rows are excluded, which is what lets the commands stay live
   * through the window where the search is catching up. The alternative — one
   * gate over the whole list — went quiet on "Sign out" for a couple of hundred
   * milliseconds after every keystroke, for the sake of a staleness that has
   * nothing to do with it.
   */
  const hits = useMemo(
    () => flatten(commandHits, current ? shown : null),
    [commandHits, current, shown],
  );

  /** Where each group's rows start in the flat list, so a row knows its index. */
  const commandOffset = 0;
  const paperOffset = commandHits.length;
  const annotationOffset = paperOffset + (shown?.papers.length ?? 0);
  const sessionOffset = annotationOffset + (shown?.annotations.length ?? 0);
  const searchTotal =
    (shown?.papers.length ?? 0) +
    (shown?.annotations.length ?? 0) +
    (shown?.sessions.length ?? 0);
  /** What is on screen, stale rows included — the number the footer reports. */
  const drawn = commandHits.length + searchTotal;

  /**
   * Which row carries the mark, and `-1` — no row — when nothing is live.
   *
   * The mark means "press Enter and you go here", so drawing it on a stale row
   * that Enter refuses to act on would be the interface telling a small lie.
   * Stale rows sit past the end of `hits`, so the bounds check is the whole
   * rule; it also covers the frame between a list shrinking and the effect
   * below putting the mark back on the first row.
   */
  const marked = active < hits.length ? active : -1;
  const actionable = hits.length > 0;

  // Keyed on `query`, not `debounced`: the command group re-ranks on the
  // keystroke, so the mark has to come home on the keystroke too.
  useEffect(() => {
    setActive(0);
  }, [query]);

  // The single door out of the palette, for the pointer and the keyboard
  // alike, and therefore the single place the staleness check has to hold.
  const go = useCallback(
    (hit: Hit | undefined) => {
      if (hit === undefined) {
        return;
      }
      if (hit.kind === "command") {
        close();
        void hit.run();
        return;
      }
      // Belt and braces: a stale hit is already absent from `hits`, so this is
      // only reachable if that invariant ever slips.
      if (!current) {
        return;
      }
      close();
      router.push(hit.href);
    },
    [close, current, router],
  );

  // The page behind must not scroll under the drawer, and focus must come back
  // to whatever the reader was on when it closes — a palette that leaves focus
  // on <body> costs a keyboard user their place on the page.
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Focused from an effect rather than `autoFocus`: the drawer is opened by a
    // keystroke and a palette you have to click into is a palette that failed.
    inputRef.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement) {
        previous.focus();
      }
    };
  }, []);

  // Keep the marked row in view without moving the page: `nearest` scrolls the
  // list by exactly as much as it has to and not a pixel more.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, shown]);

  /**
   * Driving keys at the window rather than on the input.
   *
   * The input is where they will almost always be pressed, but "almost always"
   * is not good enough for the key that closes a modal: a click on the sheet's
   * own padding takes focus off the field, and an Escape bound to the field
   * would be dead from then on. Arrows and Enter follow it for the same reason,
   * and because neither does anything a single-line field would miss.
   *
   * Home and End are deliberately *not* here — they belong to the caret. A
   * palette that steals them is a palette you cannot edit a typo in.
   */
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      // `hits`, not everything drawn: a search row that answers the previous
      // keystroke is no row worth selecting and no row worth opening, and it is
      // not in here. Those go quiet for the couple of hundred milliseconds it
      // takes to catch up. The commands never do.
      if (hits.length === 0) {
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((index) => (index + 1) % hits.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => (index - 1 + hits.length) % hits.length);
      } else if (event.key === "Enter") {
        event.preventDefault();
        go(hits[active]);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, close, go, hits]);

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    // The input is the only focusable thing in the sheet, so a trap that keeps
    // focus where it is *is* the correct cycle.
    if (event.key === "Tab") {
      event.preventDefault();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[9vh] sm:pt-[13vh]">
      <div
        aria-hidden="true"
        onMouseDown={close}
        className="absolute inset-0 backdrop-blur-[1.5px]"
        style={{ backgroundColor: "var(--shadow-ink-strong)" }}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={
          currentLab === null ? "Search" : `Search ${currentLab.name}`
        }
        className="pop-in relative flex max-h-[78vh] w-full max-w-xl flex-col overflow-hidden rounded-md border border-rule bg-surface shadow-[var(--shadow-sheet)]"
      >
        {/* The writing line. The field is serif because what you type here is
            the same stuff as what it is looking through — a title, a sentence
            somebody wrote — and the chrome around it stays sans. */}
        <div className="flex items-center gap-3 border-b border-rule px-5 py-4">
          <SearchGlyph className="size-3.5 shrink-0 text-ink-faint" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={actionable}
            aria-controls="command-palette-results"
            aria-activedescendant={
              marked >= 0 ? `command-palette-hit-${marked}` : undefined
            }
            aria-autocomplete="list"
            aria-label="Search this lab"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={
              currentLab === null
                ? "Search"
                : `Search ${currentLab.name} …`
            }
            className="w-full bg-transparent font-serif text-lg text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <span className={keycapClass}>esc</span>
        </div>

        <div
          id="command-palette-results"
          ref={listRef}
          role="listbox"
          aria-label="Results"
          aria-busy={searching}
          className="min-h-0 flex-1 overflow-y-auto py-2"
        >
          {/* Commands lead, and sit outside the dimming below: they answer the
              field synchronously, so there is never a moment where they are the
              answer to an older question. */}
          <Group label="Commands" count={commandHits.length}>
            {commandHits.map((command, i) => (
              <Row
                key={command.label}
                index={commandOffset + i}
                active={marked === commandOffset + i}
                onPoint={setActive}
                onPick={() => go(hits[commandOffset + i])}
              >
                {/* Sans, where every other row is serif: the rest of this list
                    is things the lab wrote, and a command is chrome. */}
                <span className="font-sans text-sm text-ink-strong">
                  {command.label}
                </span>
              </Row>
            ))}
          </Group>

          {/* Stale rows fade back and stop taking the pointer, which is the
              same refusal the arrow keys make above — a row you can still click
              is a row that can still open the wrong thing. */}
          <div
            role="presentation"
            className={
              "transition-opacity duration-200 " +
              (searching && shown !== null
                ? "pointer-events-none opacity-55"
                : "")
            }
          >
            {currentLab === null ? (
              <Aside>
                A search belongs to a lab, and you aren&rsquo;t in one yet.
              </Aside>
            ) : query.length === 0 ? (
              <Aside>
                Type a word from a title, or something somebody wrote in a
                margin.
              </Aside>
            ) : searchTotal === 0 && !current ? (
              // Nothing on screen and nothing settled: the honest state is
              // "still looking", not "found nothing".
              <ResultsSkeleton />
            ) : searchTotal === 0 ? (
              <Aside>
                Nothing in {currentLab.name} answers to &ldquo;{query}
                &rdquo;.
                <span className="mt-2 block font-sans text-xs text-ink-faint">
                  Margin looks through paper titles, the notes your lab has
                  written, and sessions someone gave a name — not the text
                  inside the PDFs.
                </span>
              </Aside>
            ) : (
              <>
                <Group label="Papers" count={shown?.papers.length ?? 0}>
                  {shown?.papers.map((paper, i) => (
                    <Row
                      key={paper._id}
                      index={paperOffset + i}
                      active={marked === paperOffset + i}
                      onPoint={setActive}
                      onPick={() => go(hits[paperOffset + i])}
                    >
                      <span className="truncate font-serif text-base leading-snug text-ink-strong">
                        {paper.title}
                      </span>
                      <Meta>
                        {[
                          paper.authors?.[0],
                          paper.year?.toString(),
                          paper.readable ? undefined : "no text yet",
                        ]
                          .filter((part) => part !== undefined)
                          .join(" · ")}
                      </Meta>
                    </Row>
                  ))}
                </Group>

                <Group label="Notes" count={shown?.annotations.length ?? 0}>
                  {shown?.annotations.map((annotation, i) => {
                    const style = typeStyle(annotation.type);
                    return (
                      <Row
                        key={annotation._id}
                        index={annotationOffset + i}
                        active={marked === annotationOffset + i}
                        onPoint={setActive}
                        onPick={() => go(hits[annotationOffset + i])}
                      >
                        <span className="flex items-baseline gap-2">
                          {/* The type is data, so its ink is looked up at
                              runtime — the ontology deliberately has no utility
                              classes. */}
                          <span
                            className="shrink-0 font-sans text-[10px] uppercase tracking-[0.14em]"
                            style={{ color: style.ink }}
                          >
                            {style.label}
                          </span>
                          {annotation.visibility === "private" && (
                            <span className={chipClass}>Private</span>
                          )}
                        </span>
                        <span className="line-clamp-2 font-serif text-sm leading-relaxed text-ink">
                          {annotation.preview}
                        </span>
                        <Meta>
                          {[
                            annotation.mine ? "You" : annotation.authorName,
                            annotation.paperTitle,
                            `p. ${annotation.pageIndex + 1}`,
                          ]
                            .filter((part) => part !== undefined)
                            .join(" · ")}
                        </Meta>
                      </Row>
                    );
                  })}
                </Group>

                <Group label="Sessions" count={shown?.sessions.length ?? 0}>
                  {shown?.sessions.map((session, i) => {
                    const label = statusLabel(session.status);
                    return (
                      <Row
                        key={session._id}
                        index={sessionOffset + i}
                        active={marked === sessionOffset + i}
                        onPoint={setActive}
                        onPick={() => go(hits[sessionOffset + i])}
                      >
                        <span className="flex items-baseline gap-2">
                          <span className="truncate font-serif text-base leading-snug text-ink-strong">
                            {session.title ??
                              session.paperTitle ??
                              "A session on a missing paper"}
                          </span>
                          {label !== null && (
                            <span className={`${chipClass} shrink-0`}>
                              {label}
                            </span>
                          )}
                        </span>
                        <Meta>
                          {[
                            formatDate(session.scheduledAt),
                            relativeWhen(session.scheduledAt),
                            session.title === undefined
                              ? undefined
                              : session.paperTitle,
                          ]
                            .filter((part) => part !== undefined)
                            .join(" · ")}
                        </Meta>
                      </Row>
                    );
                  })}
                </Group>
              </>
            )}
          </div>
        </div>

        {/* The brass label along the bottom of the drawer. */}
        <div className="flex items-center gap-4 border-t border-rule bg-surface-sunken px-5 py-2.5 font-sans text-[11px] text-ink-faint">
          <Legend keys={["↑", "↓"]}>move</Legend>
          <Legend keys={["↵"]}>open</Legend>
          <Legend keys={["esc"]}>close</Legend>
          <span aria-live="polite" className="ml-auto tabular-nums">
            {drawn === 0
              ? ""
              : `${drawn} ${drawn === 1 ? "result" : "results"}`}
          </span>
        </div>
      </div>
    </div>
  );
}

/** A group's heading and its rows — drawn only when it caught something. */
function Group({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  if (count === 0) {
    return null;
  }
  return (
    <div role="group" aria-label={label} className="pb-2">
      {/* The group already carries the name; the heading is the drawn half of
          it, and a screen reader hearing both would hear it twice. */}
      <h2 aria-hidden="true" className={`${eyebrowClass} px-5 pt-3 pb-1.5`}>
        {label}
      </h2>
      {children}
    </div>
  );
}

/**
 * One card in the drawer.
 *
 * `onMouseMove` rather than `onMouseEnter`: scrolling the list with the arrow
 * keys drags rows under a stationary cursor, and an enter handler would let
 * the mouse silently take the selection back from the keyboard.
 *
 * No `cursor-pointer` here, and the colour transition comes from `pressable`
 * rather than a bare `transition-colors`: a row is pressed like a button even
 * though it is a div, so it gets the press grammar, and the base layer in
 * `globals.css` already answers the cursor for `[role="option"]`.
 */
function Row({
  index,
  active,
  onPoint,
  onPick,
  children,
}: {
  index: number;
  active: boolean;
  onPoint: (index: number) => void;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <div
      id={`command-palette-hit-${index}`}
      role="option"
      aria-selected={active}
      data-active={active}
      onMouseMove={() => onPoint(index)}
      onClick={onPick}
      className={
        "pressable flex flex-col gap-0.5 border-l-2 px-5 py-2.5 " +
        (active
          ? "border-accent bg-surface-sunken"
          : "border-transparent hover:bg-surface-sunken/60")
      }
    >
      {children}
    </div>
  );
}

/** The sans undertext every row ends on: who, where, when. */
function Meta({ children }: { children: ReactNode }) {
  return (
    <span className="truncate font-sans text-xs text-ink-faint">
      {children}
    </span>
  );
}

/** Anything the drawer has to say instead of results, in the product's voice. */
function Aside({ children }: { children: ReactNode }) {
  return (
    <p className="px-5 py-6 font-serif text-sm leading-relaxed text-ink-muted">
      {children}
    </p>
  );
}

function Legend({ keys, children }: { keys: string[]; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      {keys.map((key) => (
        <kbd key={key} className={keycapClass}>
          {key}
        </kbd>
      ))}
      {children}
    </span>
  );
}

/** The shape of an answer, while the first one is on its way. */
function ResultsSkeleton() {
  return (
    <div role="status" aria-label="Searching" className="flex flex-col gap-3 px-5 py-4">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex flex-col gap-1.5">
          <span
            aria-hidden
            className={`${skeletonClass} h-4 w-3/5`}
            style={{ animationDelay: `${row * 140}ms` }}
          />
          <span
            aria-hidden
            className={`${skeletonClass} h-3 w-2/5`}
            style={{ animationDelay: `${row * 140 + 70}ms` }}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * The visible half of the shortcut, in the rail.
 *
 * A keystroke nobody has been told about is a feature that does not exist, so
 * the affordance carries the keys it stands for. Which keys those are is only
 * knowable in the browser, so the cap is held back until after hydration
 * rather than guessing and correcting — the row keeps its size either way.
 * `shortcutLabel` is the pure half of that answer, tested in
 * `lib/command.test.ts`.
 */
export function SearchAffordance() {
  const { open } = useCommandPalette();
  const [shortcut, setShortcut] = useState<string | null>(null);

  useEffect(() => {
    setShortcut(shortcutLabel(window.navigator.platform));
  }, []);

  return (
    <button
      type="button"
      onClick={open}
      className="pressable flex items-center gap-2 rounded-sm border border-rule bg-surface px-3 py-2 text-left hover:border-ink-faint"
    >
      <SearchGlyph className="size-3.5 shrink-0 text-ink-faint" />
      <span className="font-sans text-sm text-ink-muted">Search</span>
      <span className={`${keycapClass} ml-auto`}>{shortcut ?? " "}</span>
    </button>
  );
}
