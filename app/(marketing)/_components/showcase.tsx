"use client";

import {
  motion,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
} from "motion/react";
import { useEffect, useRef, useState } from "react";
import { AnnotatedPassage, TOTAL_NOTES } from "./annotated-passage";

/**
 * Fig. 1, performed.
 *
 * The figure sits pinned near the top of the viewport while the section
 * scrolls, and the five notes arrive in reading order as the reader moves —
 * the demo *is* the artifact filling in, no video, no chrome. Scroll maps to
 * a count, the count flips data-attributes, and CSS does the rest, so
 * scrubbing backwards un-writes the session note by note.
 *
 * On top of that, a few degrees of tilt follow the pointer, spring-damped —
 * enough for the sheet to acknowledge the hand, never enough to bend a line
 * of text out of true.
 *
 * The server renders the figure finished. Reduced motion keeps it finished
 * and static; narrow screens keep the reveal but lose the pinning, because a
 * phone has no room to pin a page inside a page.
 */
export function ShowcaseFig1() {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.6", "end end"],
  });

  const [active, setActive] = useState(TOTAL_NOTES);

  const count = (value: number) =>
    Math.max(0, Math.min(TOTAL_NOTES, Math.floor(value * (TOTAL_NOTES + 1))));

  useMotionValueEvent(scrollYProgress, "change", (value) => {
    if (!reduce) {
      setActive(count(value));
    }
  });

  // The server ships the finished figure (for no-JS readers and crawlers);
  // the first client frame winds it back to wherever the scrollbar actually
  // is, and the reveal takes over from there.
  useEffect(() => {
    if (!reduce) {
      setActive(count(scrollYProgress.get()));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduce]);

  // ±2° of pointer-following tilt, spring-damped. Fine pointers only — the
  // effect is checked at pointermove time, so there is nothing to gate on
  // mount and nothing that can disagree with the server render.
  const rotateX = useSpring(useMotionValue(0), { stiffness: 120, damping: 18 });
  const rotateY = useSpring(useMotionValue(0), { stiffness: 120, damping: 18 });

  const tilt = (event: React.PointerEvent<HTMLDivElement>) => {
    if (reduce || event.pointerType !== "mouse") {
      return;
    }
    const box = event.currentTarget.getBoundingClientRect();
    const px = (event.clientX - box.left) / box.width - 0.5;
    const py = (event.clientY - box.top) / box.height - 0.5;
    rotateX.set(py * -2);
    rotateY.set(px * 2.5);
  };
  const settle = () => {
    rotateX.set(0);
    rotateY.set(0);
  };

  return (
    <div ref={ref} className="lg:h-[220vh]">
      <div className="lg:sticky lg:top-[7vh]">
        <motion.div
          onPointerMove={tilt}
          onPointerLeave={settle}
          style={{ rotateX, rotateY, transformPerspective: 1400 }}
        >
          <AnnotatedPassage activeNotes={reduce ? TOTAL_NOTES : active} />
        </motion.div>
      </div>
    </div>
  );
}
