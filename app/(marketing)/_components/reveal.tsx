"use client";

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import styles from "./reveal.module.css";

/**
 * Two entrances, one grammar.
 *
 * `Rise` plays once on load — it is for the masthead, which is on screen
 * before anyone scrolls, so nothing has to watch for it. `Reveal` waits until
 * its element is actually in the viewport, which is everything below the
 * fold, so something does.
 *
 * What either one looks like, and what a request for stillness does to it,
 * lives in `reveal.module.css` — including the reason neither component reads
 * the preference here.
 */
export function Rise({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <div
      className={`${styles.rise} ${className ?? ""}`}
      style={{ "--enter-delay": `${delay}s` } as CSSProperties}
    >
      {children}
    </div>
  );
}

export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The server renders this too, and false there — the attribute reads the
  // same on both sides of hydration, and only the observer ever changes it.
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          return;
        }
        setShown(true);
        // Once: an entrance that can play twice is a page that flinches when
        // you scroll back up it.
        observer.disconnect();
      },
      // A third of the block has to be showing, and the last 60px of the
      // screen do not count as showing — a line entering at the very bottom
      // edge should finish arriving before it is read.
      { threshold: 0.3, rootMargin: "0px 0px -60px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-shown={shown}
      className={`${styles.reveal} ${className ?? ""}`}
      style={{ "--enter-delay": `${delay}s` } as CSSProperties}
    >
      {children}
    </div>
  );
}
