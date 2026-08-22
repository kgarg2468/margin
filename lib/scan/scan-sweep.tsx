import type { CSSProperties } from "react";
import styles from "./scan-sweep.module.css";
import { HOVER_SWEEP_MS, SWEEP_MS, sweepDelayMs } from "./sweep-delay";

/**
 * A surface being scanned.
 *
 * Two exports, because the effect needs one thing from its host and gives one
 * thing back. `scanRowClass` is the thing it needs — somewhere to be positioned
 * against, and a hover target — and `ScanSweep` is the decoration itself, which
 * is `aria-hidden`, out of flow, and untouchable. It renders no text, occupies
 * no space, and cannot move a line of whatever it sits over.
 *
 * Where it goes is a ruling, not a default: the shelf as papers arrive and a
 * scout's report as it lands, because in both a scan is what actually just
 * happened. The session board is deliberately not on that list — a live meeting
 * is a focus surface and ambient light across it is a distraction, not a
 * signal.
 *
 * The mechanics are all in the stylesheet next door, including why this is CSS
 * and not a renderer.
 */

/**
 * What the host must wear. See the note on `.row` in the stylesheet.
 *
 * The fallback is a type-system artifact, not a real state: a CSS module is
 * typed as an open index, so every lookup is optional even for a class the file
 * plainly declares. Absorbed here rather than handed to the call site, which
 * would otherwise interpolate the word "undefined" into a class list.
 */
export const scanRowClass: string = styles.row ?? "";

export function ScanSweep({
  index = 0,
  hover = false,
  tone = "accent",
}: {
  /** Position in the list being lit, for the stagger. A lone host leaves it at 0. */
  index?: number;
  /**
   * Whether attention gets its own pass. The shelf takes it — a row under the
   * pointer is a paper being considered — and a scout's report does not: a
   * report is read, and light crossing the sentence you are on is in the way.
   */
  hover?: boolean;
  /** Whose voice the light belongs to: the lab's own, or the model's. */
  tone?: "accent" | "secondary";
}) {
  return (
    <span
      aria-hidden
      className={
        tone === "secondary"
          ? `${styles.sweep ?? ""} ${styles.secondary ?? ""}`
          : (styles.sweep ?? "")
      }
      // Every timing the stylesheet animates on is handed down from here, so
      // `sweep-delay.ts` is the only place any of them is written. The hover
      // duration is set only where a hover pass exists to read it.
      style={
        {
          "--scan-delay": `${sweepDelayMs(index)}ms`,
          "--scan-duration": `${SWEEP_MS}ms`,
          ...(hover ? { "--scan-hover-duration": `${HOVER_SWEEP_MS}ms` } : {}),
        } as CSSProperties
      }
    >
      <span className={styles.band}>
        <span className={styles.ruling} />
      </span>
      {hover && (
        <span className={styles.hover}>
          <span className={styles.ruling} />
        </span>
      )}
    </span>
  );
}
