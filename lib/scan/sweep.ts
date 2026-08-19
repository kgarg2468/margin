/**
 * The clock behind the scan, and the reason it is a clock rather than a loop.
 *
 * A scan is mostly nothing. The front crosses the field in under three
 * seconds and then the field sits still for six, and a renderer that keeps
 * asking for frames through those six seconds is spending the main thread on
 * a picture that is not changing. Margin's first feel commitment is that a
 * press renders at the display's refresh rate whatever else is happening (see
 * the motion budget in `app/globals.css`), so decoration does not get to hold
 * the thread on spec — it gets to hold it while it is actually drawing.
 *
 * Hence the shape of this module: given how long the scene has been alive, it
 * answers whether a frame is wanted, how far through the sweep we are, and —
 * the part that matters — how long the caller may sleep before anything can
 * possibly change. During the rest phase that answer is seconds, which the
 * driver spends in a timer rather than in `requestAnimationFrame`.
 *
 * None of it touches the DOM. The scheduling rule is the piece most likely to
 * be wrong in a way no screenshot would show — a sweep that never fires, a
 * wake-up computed one period late — so it is a pure function of elapsed time
 * and lives where the unit suite can reach it.
 */

/** Seconds from the start of one sweep to the start of the next. */
export const SWEEP_PERIOD = 9;

/**
 * Seconds the sweep itself occupies. The front needs about two to cross the
 * field at a pace that reads as surveying rather than wiping; the rest is the
 * trailing glow going out, which is the half people actually watch.
 */
export const SWEEP_DURATION = 2.8;

/**
 * The first sweep is late on purpose. The masthead's own entrance animations
 * are still settling for the first second of the page's life, and a scan
 * underneath them at the same moment reads as one busy event instead of two
 * quiet ones.
 */
export const SWEEP_LEAD_IN = 1.4;

export type SweepState = {
  /** Whether the picture is currently changing and a frame is warranted. */
  running: boolean;
  /** How far through the sweep, 0 at the front's birth and 1 at its death. */
  phase: number;
  /**
   * Seconds the caller may sleep before this answer can change. Meaningful
   * only while at rest; a running sweep wants the next animation frame, not a
   * timer, so it reports 0.
   */
  sleep: number;
};

/**
 * Where the sweep is, `elapsed` seconds after the scene came up.
 *
 * Negative and non-finite inputs are folded to the lead-in rather than
 * rejected: this is fed by a clock the caller reads from the browser, and a
 * decoration whose contract is "sometimes a light moves" should degrade to
 * "the light has not started yet" rather than throw inside a render loop.
 */
export function sweepAt(elapsed: number): SweepState {
  if (!Number.isFinite(elapsed) || elapsed < SWEEP_LEAD_IN) {
    const wait = Number.isFinite(elapsed) ? SWEEP_LEAD_IN - elapsed : SWEEP_LEAD_IN;
    return { running: false, phase: 0, sleep: wait };
  }

  const into = (elapsed - SWEEP_LEAD_IN) % SWEEP_PERIOD;
  if (into < SWEEP_DURATION) {
    return { running: true, phase: into / SWEEP_DURATION, sleep: 0 };
  }
  return { running: false, phase: 0, sleep: SWEEP_PERIOD - into };
}

/**
 * How bright the sweep is allowed to be at a given phase.
 *
 * The front is born already moving — a light that fades *in* looks like a
 * loading state — so the attack is short and the release is long and eased,
 * which is what makes the field seem to hold its topography for a moment
 * after the front has gone past. Returned separately from the front's
 * position because the shader wants both and computing them on the CPU keeps
 * the fragment stage to the one thing it is good at.
 */
export function sweepEnvelope(phase: number): number {
  if (phase <= 0 || phase >= 1) {
    return 0;
  }
  const attack = Math.min(phase / 0.06, 1);
  const release = 1 - phase;
  return attack * release * release;
}
