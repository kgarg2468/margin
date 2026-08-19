"use client";

import { Canvas, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { useScanPalette } from "@/lib/scan/palette";
import { sweepAt, sweepEnvelope } from "@/lib/scan/sweep";

/**
 * The field under the masthead, and the light that surveys it.
 *
 * The masthead is already a sheet of graph paper — a flat ruling that lights
 * under the cursor. This is the same idea given a third dimension and a
 * different reason to move: a topography drawn as a wireframe, dark and
 * almost unreadable at rest, crossed every few seconds by a front that lifts
 * the terrain into view and leaves it glowing for a moment behind it. The
 * reference is the odradek's terrain scan; the restraint is Margin's. At rest
 * this should read as texture, not as a scene. The sweep is the only event.
 *
 * Three decisions carry most of the weight, and none of them are obvious:
 *
 * The wireframe is drawn in the fragment shader, not by wireframe geometry.
 * `wireframe: true` gives you triangle edges — every quad crossed by a
 * diagonal — which reads as a mesh from a modelling tool rather than as a
 * survey grid, and line width is not something WebGL will honour anyway. A
 * grid derived from the surface's own coordinates and antialiased with
 * `fwidth` is one draw call, stays crisp at any resolution, and lets the
 * distance fade do its work analytically instead of with a fog hack.
 *
 * The renderer is on demand, not on a loop. See `lib/scan/sweep.ts`: the
 * scene is animating for under a third of its life, and the other two thirds
 * are a still picture. Frames are asked for by hand — `requestAnimationFrame`
 * while the front is moving, a `setTimeout` across the gap — so the six quiet
 * seconds of every cycle cost nothing at all on the main thread. Margin's
 * first feel commitment is that a press renders at the display's refresh rate
 * regardless; decoration that idles in rAF is exactly how that gets lost.
 *
 * The scene never re-renders React. Uniforms are written straight onto the
 * material through a ref, from a loop that allocates nothing per frame. React
 * is not in the animation path here any more than it is in the pen's.
 */

/* The plane is wide and shallow, laid flat and seen from just above it, so
   most of its area is compressed into the distance where the grid becomes a
   wash and costs nothing to look at. */
const FIELD_WIDTH = 30;
const FIELD_DEPTH = 22;
const SEGMENTS_X = 88;
const SEGMENTS_Y = 64;

/** Where the pulse is born, in the field's own coordinates: near, and left. */
const ORIGIN = new THREE.Vector2(-7, -6);

/** How far the front travels over one sweep — past the far corner, so it leaves. */
const REACH = 32;

const uniformValues = () => ({
  uFront: { value: -1 },
  uAmp: { value: 0 },
  uAccent: { value: new THREE.Color("#7fa3d8") },
  uRest: { value: new THREE.Color("#938578") },
  uOrigin: { value: ORIGIN },
  uTail: { value: 6 },
  uRelief: { value: 1.5 },
  uPitch: { value: 0.62 },
  /* Lines a little over a pixel wide. Exactly one pixel is what the
     derivative gives you for free and it reads as a dotted screen door once
     the grid tilts away; the extra fraction is what keeps it a drawn line. */
  uWidth: { value: 1.7 },
  uRestAlpha: { value: 0.115 },
  uHalfWidth: { value: FIELD_WIDTH / 2 },
  uHalfDepth: { value: FIELD_DEPTH / 2 },
});

/**
 * Value noise, three octaves, hashed rather than sampled.
 *
 * A texture would be smoother and would also be a network request and a
 * second thing to keep in step with the palette. The terrain only has to be
 * plausible under a grid at a grazing angle, which this clears easily.
 */
const NOISE = /* glsl */ `
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
  float fbm(vec2 p) {
    float total = 0.0;
    float amplitude = 0.5;
    for (int octave = 0; octave < 3; octave++) {
      total += amplitude * vnoise(p);
      p *= 2.03;
      amplitude *= 0.5;
    }
    return total;
  }
`;

/**
 * How lit a point is: nothing at all ahead of the front, and behind it two
 * decays at once.
 *
 * The two are the whole character of the effect. A single exponential — which
 * is the obvious way to write this — spreads the light over the entire field
 * and reads as a gradient drifting past, not as a survey. What makes it a
 * scan is a tight rim at the front, bright and about a unit deep, with a much
 * dimmer wash trailing several units behind it: the edge is the instrument
 * and the wash is the ground still holding the light.
 *
 * Ahead of the front there is a hard cut, softened over a sixth of a unit —
 * enough to keep it from staircasing where it crosses the ruling at a shallow
 * angle, not enough to blunt it.
 */
const PULSE = /* glsl */ `
  uniform float uFront;
  uniform float uAmp;
  uniform float uTail;
  uniform vec2 uOrigin;

  /* x is the rim alone, y is everything the front has lit. They are returned
     together because the fragment stage spends them differently: the wash
     brightens the ruling, but only the rim is allowed to glow off the ground
     between the lines — light that spilled evenly out of the whole tail would
     fog the masthead instead of crossing it. */
  vec2 pulseAt(vec2 field) {
    float behind = uFront - distance(field, uOrigin);
    if (behind < 0.0) {
      return vec2(0.0);
    }
    float soften = smoothstep(0.0, 0.16, behind) * uAmp;
    float rim = exp(-behind / 0.9) * soften;
    float wash = exp(-behind / uTail) * 0.4 * soften;
    return vec2(rim, rim + wash);
  }
`;

const VERTEX = /* glsl */ `
  uniform float uRelief;
  varying vec2 vField;
  varying float vPulse;
  varying float vRim;
  varying float vRidge;

  ${NOISE}
  ${PULSE}

  void main() {
    vec3 place = position;
    // The plane is built in its own XY and rotated flat by the mesh, so local
    // +z is the world's up and this is the only axis terrain happens on.
    float ridge = fbm(place.xy * 0.42) - 0.5;
    vec2 pulse = pulseAt(place.xy);
    // The front does not merely light the ground, it raises it: terrain comes
    // up into the light as the edge arrives and settles again behind it.
    place.z += ridge * uRelief * (1.0 + pulse.y * 0.75);

    vField = place.xy;
    vPulse = pulse.y;
    vRim = pulse.x;
    vRidge = ridge;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(place, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uAccent;
  uniform vec3 uRest;
  uniform float uPitch;
  uniform float uWidth;
  uniform float uRestAlpha;
  uniform float uHalfWidth;
  uniform float uHalfDepth;
  varying vec2 vField;
  varying float vPulse;
  varying float vRim;
  varying float vRidge;

  /* Coverage of the nearest ruling, in pixels, so a line is one pixel wide
     wherever it lands rather than one field-unit wide in the foreground and
     invisible at the horizon. */
  float ruling(vec2 field, float pitch) {
    vec2 cell = field / pitch;
    vec2 distanceToLine = abs(fract(cell - 0.5) - 0.5) / (fwidth(cell) * uWidth);
    return 1.0 - clamp(min(distanceToLine.x, distanceToLine.y), 0.0, 1.0);
  }

  void main() {
    float line = ruling(vField, uPitch);

    // The sheet has no border. It thins into the distance and at both sides,
    // so nothing on screen ever announces where the geometry stops.
    float far = smoothstep(uHalfDepth * 0.35, uHalfDepth * 1.15, vField.y);
    float near = smoothstep(-uHalfDepth, -uHalfDepth * 0.8, vField.y);
    float sides = 1.0 - smoothstep(0.5, 1.0, abs(vField.x) / uHalfWidth);
    float sheet = (1.0 - far) * near * sides;

    vec3 tint = mix(uRest, uAccent, clamp(vPulse * 1.7 + 0.2, 0.0, 1.0));

    // Ridges catch the front the way high ground catches a low sun, which is
    // most of what makes the lit moment read as terrain rather than as a grid.
    float relief = 0.55 + 0.45 * smoothstep(-0.2, 0.3, vRidge);
    float alpha = line * (uRestAlpha + vPulse * 1.9 * relief);
    // The rim, and only the rim, glows off the ground between the lines. This
    // is what gives the front a body and lets it be seen crossing ground the
    // ruling has already thinned out of.
    alpha += vRim * 0.24 * relief;

    gl_FragColor = vec4(tint, clamp(alpha * sheet, 0.0, 1.0));
  }
`;

/**
 * The mesh, and the hand-driven clock that feeds it.
 *
 * `animate` false covers three different silences — reduced motion, a hidden
 * tab, a hero scrolled past — and they all want the same thing: the rest
 * frame, drawn once, and then nothing.
 */
function Field({
  accent,
  rest,
  animate,
}: {
  accent: string;
  rest: string;
  animate: boolean;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const camera = useThree((state) => state.camera);
  const uniforms = useMemo(uniformValues, []);

  useEffect(() => {
    // Pitched down far enough that the plane's own horizon sits above the top
    // of the frame: a visible horizon line would make this a landscape, and
    // the field is meant to be ground seen from a desk, not a view.
    camera.lookAt(0, -0.6, -1);
  }, [camera]);

  useEffect(() => {
    // `set` parses the CSS value in place; a new Color per theme change would
    // be harmless, but this is also the code path a hot loop must not tempt.
    try {
      uniforms.uAccent.value.set(accent);
      uniforms.uRest.value.set(rest);
    } catch {
      // A token that does not parse as a colour is a reason to keep the
      // previous one, not a reason to take down the masthead.
    }
    invalidate();
  }, [accent, rest, uniforms, invalidate]);

  useEffect(() => {
    if (!animate) {
      uniforms.uFront.value = -1;
      uniforms.uAmp.value = 0;
      invalidate();
      return;
    }

    let frame = 0;
    let timer = 0;
    let live = true;
    const born = performance.now();

    const tick = () => {
      if (!live) {
        return;
      }
      const state = sweepAt((performance.now() - born) / 1000);
      uniforms.uFront.value = state.running ? REACH * state.phase ** 0.85 : -1;
      uniforms.uAmp.value = state.running ? sweepEnvelope(state.phase) : 0;
      invalidate();

      if (state.running) {
        frame = requestAnimationFrame(tick);
      } else {
        // The whole point: across the gap between sweeps there is no animation
        // frame outstanding at all, so the compositor and the main thread are
        // free for whatever the reader is actually doing.
        timer = window.setTimeout(tick, Math.max(state.sleep * 1000, 16));
      }
    };
    tick();

    return () => {
      live = false;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [animate, uniforms, invalidate]);

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -2.2, -4]}>
      <planeGeometry
        args={[FIELD_WIDTH, FIELD_DEPTH, SEGMENTS_X, SEGMENTS_Y]}
      />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={VERTEX}
        fragmentShader={FRAGMENT}
        transparent
        depthWrite={false}
      />
    </mesh>
  );
}

/**
 * Whether the field should be moving: on screen, in a visible tab, and asked
 * for.
 *
 * Reduced motion is read once and not watched. Someone who changes that
 * setting mid-session gets the answer on their next navigation, and the
 * alternative — a listener that can switch a WebGL scene into motion under a
 * reader who just asked for less of it — is the worse failure of the two.
 */
function useAnimating(element: Element | null): boolean {
  const [onScreen, setOnScreen] = useState(false);
  const [awake, setAwake] = useState(true);
  const [allowed] = useState(
    () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    if (element === null) {
      return;
    }
    const watcher = new IntersectionObserver(
      (entries) => setOnScreen(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "120px" },
    );
    watcher.observe(element);

    const visibility = () => setAwake(!document.hidden);
    visibility();
    document.addEventListener("visibilitychange", visibility);

    return () => {
      watcher.disconnect();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [element]);

  return allowed && onScreen && awake;
}

/**
 * The canvas, framed.
 *
 * The mask is CSS rather than shader work because it is about where the
 * masthead ends, not about where the field does — the hero's own ruling fades
 * on the same fold, and the two have to agree.
 */
export default function ScanField() {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const palette = useScanPalette(host);
  const animate = useAnimating(host);

  return (
    <div
      ref={setHost}
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        maskImage:
          "linear-gradient(to bottom, rgba(0,0,0,0.5), rgba(0,0,0,0.95) 35%, rgba(0,0,0,0.9) 72%, transparent 97%)",
        WebkitMaskImage:
          "linear-gradient(to bottom, rgba(0,0,0,0.5), rgba(0,0,0,0.95) 35%, rgba(0,0,0,0.9) 72%, transparent 97%)",
      }}
    >
      <Canvas
        // Every frame this scene draws is one it asked for; see `Field`.
        frameloop="demand"
        // Retina is worth having for hairlines; anything past 2x is spending
        // four times the fill rate on a decoration nobody is inspecting.
        dpr={[1, 2]}
        camera={{ position: [0, 3.4, 8], fov: 40, near: 0.1, far: 60 }}
        gl={{
          alpha: true,
          // The grid is antialiased in the shader, so MSAA would be paying
          // twice for the only edges on screen.
          antialias: false,
          powerPreference: "low-power",
        }}
        style={{ pointerEvents: "none" }}
      >
        <Field accent={palette.accent} rest={palette.rest} animate={animate} />
      </Canvas>
    </div>
  );
}
