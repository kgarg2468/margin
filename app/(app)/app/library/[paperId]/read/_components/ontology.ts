import type { Doc } from "@/convex/_generated/dataModel";

/**
 * The seven-value annotation ontology, with the ink each one is written in.
 *
 * `note` is the untyped default and typing is one tap, never required — so the
 * order here is the order of the chips, and `note` comes first.
 *
 * Colour is a lookup rather than a class name because a note's type is *data*:
 * `app/globals.css` deliberately declares no utility classes for the annotation
 * inks and expects them to be read at runtime as `var(--note-*)`. Each type
 * carries two: an ink for the card and the badge, and a lighter wash for the
 * passage itself.
 *
 * All six typed values have their own hue. `definition` was the last to get
 * one — it stood in plain ink over a neutral wash while the palette was five
 * hues wide — and `--note-definition` closes that gap.
 */
export type AnnotationType = Doc<"annotations">["type"];

export type TypeStyle = {
  value: AnnotationType;
  label: string;
  /** For the type badge, the card's rule, and the underline in the text. */
  ink: string;
  /** For the passage wash when the note is active. */
  wash: string;
};

export const ANNOTATION_TYPES: readonly TypeStyle[] = [
  {
    value: "note",
    label: "Note",
    ink: "var(--ink-faint)",
    wash: "var(--highlight)",
  },
  {
    value: "hypothesis",
    label: "Hypothesis",
    ink: "var(--note-hypothesis)",
    wash: "var(--note-hypothesis-wash)",
  },
  {
    value: "method-note",
    label: "Method",
    ink: "var(--note-method)",
    wash: "var(--note-method-wash)",
  },
  {
    value: "critique",
    label: "Critique",
    ink: "var(--note-critique)",
    wash: "var(--note-critique-wash)",
  },
  {
    value: "definition",
    label: "Definition",
    ink: "var(--note-definition)",
    wash: "var(--note-definition-wash)",
  },
  {
    value: "connection-to-own-work",
    label: "Connection",
    ink: "var(--note-connection)",
    wash: "var(--note-connection-wash)",
  },
  {
    value: "open-question",
    label: "Open question",
    ink: "var(--note-question)",
    wash: "var(--note-question-wash)",
  },
];

const BY_VALUE = new Map(ANNOTATION_TYPES.map((style) => [style.value, style]));

export function typeStyle(type: AnnotationType): TypeStyle {
  return BY_VALUE.get(type) ?? (ANNOTATION_TYPES[0] as TypeStyle);
}
