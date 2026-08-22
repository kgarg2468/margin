"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

/**
 * The reader's motion preference, held back until the client owns the page.
 *
 * `useReducedMotion` answers from a media query, and a media query is a
 * question the server has nobody to ask: it renders as though the answer were
 * no, then the first client render reads the real one and produces different
 * markup. React does not reconcile that — it throws the tree away and rebuilds
 * it, which on this page is the whole landing page. Withholding the answer for
 * one commit makes the HTML that was sent the HTML that gets hydrated, and
 * costs a single frame of decoration nobody with the preference set wanted to
 * see anyway.
 *
 * This is for the decorations that are on the page either way — a rule, a
 * progress hairline, a highlight — where one frame of the motion-tolerant
 * version is invisible in practice. It is deliberately *not* what the
 * entrances use: an element that starts at `opacity: 0` cannot wait a frame to
 * learn whether it should have, so `reveal.module.css` asks the media query in
 * CSS, where the answer arrives before the first paint.
 */
export function useSettledReducedMotion(): boolean {
  const reduce = useReducedMotion();
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    setSettled(true);
  }, []);

  return settled && reduce === true;
}
