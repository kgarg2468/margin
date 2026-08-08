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
import { AnnotatedPassage, TOTAL_SCENES } from "./annotated-passage";

/**
 * Fig. 1, performed.
 *
 * The figure sits pinned near the top of the viewport while the section
 * scrolls, and the session plays in eight beats as the reader moves — notes
 * arriving, the composer opening and typing, the synthesis drafting itself.
 * The demo *is* the artifact filling in: no video, no chrome. Scroll maps to
 * a beat, the beat flips data-attributes, and CSS does the rest, so
 * scrubbing backwards un-writes the session beat by beat.
 *
 * On top of that the sheet follows the pointer: a few degrees of
 * spring-damped tilt, and a soft sheen that sits where the hand is — enough
 * for the paper to acknowledge the reader, never enough to bend a line of
 * text out of true.
 *
 * The figure is taller than the viewport once the composer and synthesis
 * are in play, so a camera pans it: while the pinned card overflows, later
 * beats spring the sheet upward — first to hold the § 5 row (where note 5
 * is being written) in view, then to the synthesis at the foot. Rewinding
 * the scroll pans back the same way.
 *
 * The server renders the figure finished. Reduced motion keeps it finished
 * and static; narrow screens keep the reveal but lose the pinning, because a
 * phone has no room to pin a page inside a page.
 */
export function ShowcaseFig1() {
  const ref = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.6", "end end"],
  });

  const [scene, setScene] = useState(TOTAL_SCENES);

  const beat = (value: number) =>
    Math.max(0, Math.min(TOTAL_SCENES, Math.floor(value * (TOTAL_SCENES + 1))));

  useMotionValueEvent(scrollYProgress, "change", (value) => {
    if (!reduce) {
      setScene(beat(value));
    }
  });

  // The server ships the finished figure (for no-JS readers and crawlers);
  // the first client frame winds it back to wherever the scrollbar actually
  // is, and the performance takes over from there.
  useEffect(() => {
    if (!reduce) {
      setScene(beat(scrollYProgress.get()));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduce]);

  // The camera. Its target is recomputed whenever the beat changes or the
  // sheet changes size (the synthesis growing at scene 8 is a resize, which
  // is exactly when the pan to the foot of the card must finish the job).
  const pan = useSpring(useMotionValue(0), { stiffness: 70, damping: 22 });
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  useEffect(() => {
    const element = stage.current;
    if (element === null || reduce) {
      return;
    }

    const aim = () => {
      // Only the pinned layout needs a camera; below lg the figure scrolls
      // free and the page itself is the camera.
      if (!window.matchMedia("(min-width: 1024px)").matches) {
        pan.set(0);
        return;
      }
      const current = sceneRef.current;
      const box = element.getBoundingClientRect();
      // Where the card would sit with no pan at all. Near the end of the
      // pinned stretch the sticky element slides up on its own; measuring
      // from its true position keeps the camera from stacking on top of
      // that and leaving a gap under the card.
      const top = box.top - pan.get();
      const foot = window.innerHeight - 16;
      const overflow = Math.max(0, top + box.height - foot);
      if (overflow === 0 || current < 5) {
        pan.set(0);
        return;
      }
      if (current >= TOTAL_SCENES) {
        // Scene 8: the synthesis at the foot of the card, so the whole
        // artifact reads finished.
        pan.set(-overflow);
        return;
      }
      // Scenes 5–7: hold the § 5 row (and the composer opening above it)
      // at the foot of the viewport. The row offset is a rect delta, so it
      // is unaffected by wherever the pan is mid-flight.
      const row = element.querySelector('[data-camera="focus"]');
      if (row === null) {
        pan.set(0);
        return;
      }
      const rowBottom = row.getBoundingClientRect().bottom - box.top;
      pan.set(Math.max(-overflow, Math.min(0, foot - 4 - (top + rowBottom))));
    };

    aim();
    const sized = new ResizeObserver(aim);
    sized.observe(element);
    window.addEventListener("resize", aim);
    // The sticky element starts sliding on its own near the end of the
    // pinned stretch, so the target moves with scroll, not just with the
    // beat. aim() is a couple of rect reads; cheap enough to run raw.
    window.addEventListener("scroll", aim, { passive: true });
    return () => {
      sized.disconnect();
      window.removeEventListener("resize", aim);
      window.removeEventListener("scroll", aim);
    };
  }, [scene, reduce, pan]);

  // Pointer-following tilt and sheen, spring-damped. Fine pointers only —
  // both are checked at pointermove time, so there is nothing to gate on
  // mount and nothing that can disagree with the server render.
  const rotateX = useSpring(useMotionValue(0), { stiffness: 120, damping: 18 });
  const rotateY = useSpring(useMotionValue(0), { stiffness: 120, damping: 18 });

  const tilt = (event: React.PointerEvent<HTMLDivElement>) => {
    if (reduce || event.pointerType !== "mouse") {
      return;
    }
    const element = stage.current;
    const box = event.currentTarget.getBoundingClientRect();
    const px = (event.clientX - box.left) / box.width - 0.5;
    const py = (event.clientY - box.top) / box.height - 0.5;
    rotateX.set(py * -3.5);
    rotateY.set(px * 4.5);
    if (element !== null) {
      element.style.setProperty("--gx", `${event.clientX - box.left}px`);
      element.style.setProperty("--gy", `${event.clientY - box.top}px`);
      element.style.setProperty("--sheen", "1");
    }
  };
  const settle = () => {
    rotateX.set(0);
    rotateY.set(0);
    stage.current?.style.setProperty("--sheen", "0");
  };

  return (
    <div ref={ref} className="lg:h-[320vh]">
      <div className="lg:sticky lg:top-[6vh]">
        <motion.div
          ref={stage}
          onPointerMove={tilt}
          onPointerLeave={settle}
          className="relative"
          style={{ rotateX, rotateY, y: pan, transformPerspective: 1400 }}
        >
          <AnnotatedPassage scene={reduce ? TOTAL_SCENES : scene} />
          {/* the sheen: lamplight catching the sheet where the hand is */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-md transition-opacity duration-500"
            style={{
              opacity: "calc(var(--sheen, 0) * 1)",
              background:
                "radial-gradient(420px circle at var(--gx, 50%) var(--gy, 0%), color-mix(in oklab, var(--accent) 6%, transparent), transparent 65%)",
            }}
          />
        </motion.div>
      </div>
    </div>
  );
}
