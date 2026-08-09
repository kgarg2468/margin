/**
 * The line from a passage to the note about it.
 *
 * It lives in the gutter between the sheet and the margin, not across the page:
 * a leader drawn from the sentence itself would run over the paragraph it is
 * pointing at, which is a strange thing to do to a reader in the name of
 * helping them read. So it starts at the right edge of the page and ends at the
 * left edge of the card, and the highlight on the sentence — brighter now, see
 * `mark-alpha.ts` — does the work at the other end.
 *
 * A cubic with both control points level with their own endpoint, so the line
 * leaves the paper horizontally and arrives at the card horizontally. A
 * straight diagonal reads as a strike-through of the gutter; this reads as a
 * bracket.
 *
 * All coordinates in and out are the rail spacer's own. The function knows
 * nothing about the DOM, which is the point.
 */

export type ConnectorPoint = { x: number; y: number };

export type ConnectorGeometry = {
  /** The `<svg>` box, positioned absolutely inside the rail's spacer. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** `d` for a single cubic, in the box's own coordinates. */
  path: string;
};

/** Below this the line is a smudge, and a smudge in the margin is a defect. */
const MIN_WIDTH = 2;

export function connectorGeometry(
  passage: ConnectorPoint,
  card: ConnectorPoint,
  options: { padding?: number } = {},
): ConnectorGeometry | null {
  const padding = options.padding ?? 3;
  const width = card.x - passage.x;
  if (width < MIN_WIDTH) {
    return null;
  }

  const top = Math.min(passage.y, card.y) - padding;
  const height = Math.abs(card.y - passage.y) + padding * 2;
  const fromY = passage.y - top;
  const toY = card.y - top;
  // 0.55 rather than 0.5: the two control points overlap slightly, which keeps
  // the curve from developing a flat middle at the shallow angles this is drawn
  // at most of the time.
  const bend = width * 0.55;

  const path =
    `M 0 ${round(fromY)} ` +
    `C ${round(bend)} ${round(fromY)}, ` +
    `${round(width - bend)} ${round(toY)}, ` +
    `${round(width)} ${round(toY)}`;

  return { left: passage.x, top, width, height, path };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
