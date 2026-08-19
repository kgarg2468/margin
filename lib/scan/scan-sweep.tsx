import styles from "./scan-sweep.module.css";

/**
 * A row being scanned: the shelf's version of what crosses the masthead.
 *
 * Two exports, because the effect needs one thing from its host and gives one
 * thing back. `scanRowClass` is the thing it needs — somewhere to be
 * positioned against, and a hover target — and `ScanSweep` is the decoration
 * itself, which is `aria-hidden`, out of flow, and untouchable. It renders no
 * text, occupies no space, and cannot move a line of the row it sits over.
 *
 * The mechanics are all in the stylesheet next door, including why this is
 * CSS at all when the masthead is WebGL.
 */

/**
 * What the host row must wear. See the note on `.row` in the stylesheet.
 *
 * The fallback is a type-system artifact, not a real state: a CSS module is
 * typed as an open index, so every lookup is optional even for a class the
 * file plainly declares. Absorbed here rather than handed to the call site,
 * which would otherwise interpolate the word "undefined" into a class list.
 */
export const scanRowClass: string = styles.row ?? "";

/**
 * Rows past this one arrive without a stagger. A shelf is not a countdown;
 * beyond the first handful the delay stops reading as sequence and starts
 * reading as latency.
 */
const STAGGERED = 8;

const STEP_MS = 70;
const OFFSET_MS = 120;

export function ScanSweep({ index = 0 }: { index?: number }) {
  const delay = OFFSET_MS + Math.min(index, STAGGERED) * STEP_MS;

  return (
    <span
      aria-hidden
      className={styles.sweep}
      style={{ "--scan-delay": `${delay}ms` } as React.CSSProperties}
    >
      <span className={styles.band}>
        <span className={styles.ruling} />
      </span>
      <span className={styles.hover}>
        <span className={styles.ruling} />
      </span>
    </span>
  );
}
