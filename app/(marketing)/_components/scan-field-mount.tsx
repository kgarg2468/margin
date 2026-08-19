"use client";

import dynamic from "next/dynamic";

/**
 * Where three.js is allowed to enter the application, and nowhere else.
 *
 * The renderer is most of a megabyte before the scene is written, and the
 * masthead is the only place on the marketing page that wants it. Two things
 * follow, and this three-line file exists to hold both of them in one place:
 * the import is dynamic, so the bundle is a separate chunk fetched after the
 * page is interactive rather than part of it; and it is `ssr: false`, because
 * a WebGL context cannot be produced on a server and prerendering the scene
 * would only mean shipping markup for a canvas that has to be thrown away.
 *
 * `ssr: false` is also why this is a client component rather than the page
 * importing `next/dynamic` itself — a server component is not permitted to
 * opt a child out of the server.
 *
 * `loading` is deliberately absent. There is nothing to say while a
 * decoration is on its way; a placeholder would be a spinner for a thing the
 * reader has not been told to expect.
 */
const ScanField = dynamic(() => import("./scan-field"), { ssr: false });

export function ScanFieldMount() {
  return <ScanField />;
}
