"use client";

import {
  cardClass,
  openedFromKeyboard,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/lib/ui";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useRef, useState } from "react";

/**
 * Destructive actions are quiet text, not red buttons — but they ask before
 * they fire, so nothing irreversible is ever one stray click away.
 *
 * Two tones, because "quiet" means different things in the two places this is
 * used. On the lab page a destructive action sits in a list of links and reads
 * as one of them. In a margin card it sits under a note the reader is trying
 * to look past, where `Reply` and `Edit` are already faint and the last thing
 * that should be the loudest word on the card is the one that removes it.
 *
 * Two sizes for the same reason: `xs` beside chrome, `sm` beside prose.
 */
const disabledClass = "disabled:cursor-not-allowed disabled:opacity-50";

const toneClass = {
  accent: `text-accent underline-offset-4 hover:underline ${disabledClass}`,
  faint: `text-ink-faint underline-offset-4 hover:text-ink-muted hover:underline ${disabledClass}`,
} as const;

const sizeClass = { xs: "text-xs", sm: "text-sm" } as const;

/**
 * A two-step affordance for anything that can't be undone: the first click
 * asks, the second one commits.
 *
 * The question used to be asked in place — the link swapped itself for an
 * armed pair sitting in the same row. That was quiet, which was the point, and
 * it was also skippable: nothing stopped a second stray click landing on the
 * armed word, and a keyboard user never learned the question had been asked.
 * So the question now comes to the front of the page as a real alert dialog,
 * with the focus trap, the Escape and the backdrop that come with one, and
 * with focus starting on the way *out* rather than on the way through.
 *
 * The props are unchanged, and so is what each of them means. `confirmLabel`
 * is still the whole point of the pattern and should restate what is about to
 * happen rather than say "Confirm" — it is still the only sentence anyone
 * reads before the thing is gone, and it is still the label on the button that
 * does it.
 */
export function ConfirmAction({
  label,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "accent",
  size = "xs",
  disabled = false,
  run,
}: {
  label: string;
  confirmLabel: string;
  /**
   * Only worth setting where the surrounding UI already has a Cancel — an
   * armed note card has one for the edit it is sitting inside, and two
   * controls with the same accessible name in the same card is a coin toss
   * for anyone not looking at it.
   */
  cancelLabel?: string;
  tone?: keyof typeof toneClass;
  size?: keyof typeof sizeClass;
  disabled?: boolean;
  run: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  // Entrances are for pointers, which take time to arrive; a keystroke does
  // not. See `openedFromKeyboard`.
  const [instant, setInstant] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const quiet = toneClass[tone];
  const scale = sizeClass[size];

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next, details) => {
        // Escape does not take the dialog away mid-flight. The "Working…" on
        // the confirm button is the only sign the app gives that anything is
        // happening, and a destructive action left running behind a dialog
        // that has already closed is exactly the ambiguity this control is
        // here to remove. It closes itself when `run` settles.
        if (pending && !next) {
          details.cancel();
          return;
        }
        if (next) {
          setInstant(openedFromKeyboard(details.event));
        }
        setOpen(next);
      }}
    >
      <AlertDialog.Trigger
        disabled={disabled}
        className={`font-sans ${scale} ${quiet} tap-target`}
      >
        {label}
      </AlertDialog.Trigger>

      <AlertDialog.Portal>
        {/* The page, still there but held back: a wash of its own colour and
            just enough blur to say the question is in front of it. */}
        <AlertDialog.Backdrop
          className={
            "fixed inset-0 z-50 bg-[color-mix(in_oklab,var(--page)_60%,transparent)] " +
            "backdrop-blur-[2px] transition-opacity duration-[var(--dur-enter)] ease-out " +
            "data-[ending-style]:opacity-0 data-[ending-style]:duration-[var(--dur-exit)] " +
            (instant ? "" : "data-[starting-style]:opacity-0")
          }
        />
        {/* Centred with `inset-0` + `m-auto` rather than a half-translate:
            `pop-in` animates the `translate` property, and a centring
            translate would be clobbered for the length of the entrance. */}
        <AlertDialog.Popup
          initialFocus={cancelRef}
          className={
            `${cardClass} fixed inset-0 z-50 m-auto flex h-fit w-[calc(100%-2rem)] ` +
            "max-w-sm flex-col gap-5 outline-none " +
            "transition-opacity duration-[var(--dur-exit)] ease-out " +
            "data-[ending-style]:animate-none data-[ending-style]:opacity-0 " +
            (instant ? "" : "pop-in")
          }
        >
          <AlertDialog.Title className="font-serif text-lg leading-snug text-ink-strong">
            {label}
          </AlertDialog.Title>
          {/* The way out comes first — in the DOM, in the tab order, and in
              the reading direction — and it is where focus starts. Someone who
              hit this dialog by accident should be able to leave it by pressing
              the key they are already holding. */}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <AlertDialog.Close
              ref={cancelRef}
              disabled={pending}
              className={secondaryButtonClass}
            >
              {cancelLabel}
            </AlertDialog.Close>
            <button
              type="button"
              disabled={disabled || pending}
              className={primaryButtonClass}
              onClick={async () => {
                setPending(true);
                try {
                  await run();
                } finally {
                  setPending(false);
                  setOpen(false);
                }
              }}
            >
              {pending ? "Working…" : confirmLabel}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
