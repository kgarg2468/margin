"use client";

import { useEffect, useState } from "react";

/**
 * The colours the scan is drawn in, taken from the page rather than restated.
 *
 * Margin decides light and dark twice over: the system preference wins unless
 * a `.light` / `.dark` ancestor overrides it (see `@custom-variant dark` in
 * `app/globals.css`, and the theme toggle in `lib/theme.ts` that writes that
 * class onto <html>). A WebGL scene cannot participate in either mechanism —
 * a shader uniform is a number, not a cascading value — so hardcoding two
 * palettes here would mean a third opinion about what "dark" is, and a third
 * place to update when the accent moves.
 *
 * So the scene reads the resolved custom properties instead, which is the
 * same trick the masthead's pen already uses to pick its ink. Both branches
 * come out right because neither is written down: whatever `--accent` has
 * become on this element at this moment is what the field is lit in.
 *
 * The two triggers below are the two ways that answer can change under a
 * mounted scene — the machine flipping at dusk, and the reader pressing the
 * toggle — and they are separate mechanisms, so both are watched.
 */

export type ScanPalette = {
  /** The lit wireframe, and the colour of the front itself. */
  accent: string;
  /** The field at rest: present, but only just. */
  rest: string;
};

const FALLBACK: ScanPalette = { accent: "#7fa3d8", rest: "#938578" };

function read(element: Element | null): ScanPalette {
  if (element === null) {
    return FALLBACK;
  }
  const style = getComputedStyle(element);
  const accent = style.getPropertyValue("--accent").trim();
  const rest = style.getPropertyValue("--ink-faint").trim();
  return {
    accent: accent.length > 0 ? accent : FALLBACK.accent,
    rest: rest.length > 0 ? rest : FALLBACK.rest,
  };
}

/**
 * Watches the element's inherited palette and re-reads it when the page's
 * mind changes.
 *
 * Returned as a string pair rather than a `THREE.Color` so this module stays
 * free of three entirely — it is the bridge between CSS and the scene, and a
 * bridge that imported the renderer would be pulled into every bundle that
 * only wanted to know what colour the accent is.
 */
export function useScanPalette(element: Element | null): ScanPalette {
  const [palette, setPalette] = useState<ScanPalette>(FALLBACK);

  useEffect(() => {
    if (element === null) {
      return;
    }
    const sync = () => setPalette(read(element));
    sync();

    // The toggle writes a class on <html>; nothing about that is observable
    // as an event, so the attribute itself is what gets watched.
    const classed = new MutationObserver(sync);
    classed.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    // And with no class at all, the system is still in charge and may change
    // its mind while the page is open.
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    system.addEventListener("change", sync);

    return () => {
      classed.disconnect();
      system.removeEventListener("change", sync);
    };
  }, [element]);

  return palette;
}
