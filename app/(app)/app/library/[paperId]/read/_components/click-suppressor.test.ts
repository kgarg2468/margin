import { describe, expect, it } from "vitest";
import type { ListenerHost, StoppableEvent } from "./click-suppressor";
import { suppressNextClick } from "./click-suppressor";

/**
 * The lifecycle is the whole point: one swallow, never two, and never one left
 * lying around. A listener that outlived its gesture would eat the outside
 * press somebody used to close the sheet, which is the same class of silent
 * loss the suppressor exists to prevent.
 */

type Registered = {
  type: string;
  listener: (event: StoppableEvent) => void;
  capture: boolean;
};

function fakeHost() {
  const live: Registered[] = [];
  const host: ListenerHost = {
    addEventListener: (type, listener, capture) => {
      live.push({ type, listener, capture });
    },
    removeEventListener: (type, listener, capture) => {
      const at = live.findIndex(
        (entry) =>
          entry.type === type &&
          entry.listener === listener &&
          entry.capture === capture,
      );
      if (at >= 0) {
        live.splice(at, 1);
      }
    },
  };
  const fire = (type: string) => {
    let stopped = 0;
    let stoppedImmediately = 0;
    const event: StoppableEvent = {
      stopPropagation: () => {
        stopped++;
      },
      stopImmediatePropagation: () => {
        stoppedImmediately++;
      },
    };
    for (const entry of [...live]) {
      if (entry.type === type) {
        entry.listener(event);
      }
    }
    return { stopped, stoppedImmediately };
  };
  return { host, live, fire };
}

describe("the drag's trailing click", () => {
  it("is stopped before anything else on the document can read it", () => {
    const { host, fire } = fakeHost();
    suppressNextClick(host);
    const first = fire("click");
    expect(first.stopped).toBe(1);
    expect(first.stoppedImmediately).toBe(1);
  });

  it("is listened for in the capture phase, which is the only one early enough", () => {
    const { host, live } = fakeHost();
    suppressNextClick(host);
    expect(live.every((entry) => entry.capture)).toBe(true);
    expect(live.map((entry) => entry.type).sort()).toEqual([
      "click",
      "pointerdown",
    ]);
  });
});

describe("what stops it eating a click it was not armed for", () => {
  it("swallows one click and then nothing", () => {
    const { host, fire, live } = fakeHost();
    suppressNextClick(host);
    fire("click");
    expect(live).toHaveLength(0);
    expect(fire("click").stopped).toBe(0);
  });

  it("stands down on the next gesture, click or no click", () => {
    // The trap this avoids: a drag that produces no click leaves the listener
    // armed, and the reader's next real outside press — the one they meant to
    // close the sheet with — is the one that gets swallowed instead.
    const { host, fire, live } = fakeHost();
    suppressNextClick(host);
    fire("pointerdown");
    expect(live).toHaveLength(0);
    expect(fire("click").stopped).toBe(0);
  });

  it("comes away when the page it belongs to unmounts mid-gesture", () => {
    const { host, fire, live } = fakeHost();
    const disarm = suppressNextClick(host);
    disarm();
    expect(live).toHaveLength(0);
    expect(fire("click").stopped).toBe(0);
  });

  it("does not double-remove when the click and the teardown both arrive", () => {
    const { host, fire, live } = fakeHost();
    const disarm = suppressNextClick(host);
    fire("click");
    disarm();
    expect(live).toHaveLength(0);
  });
});
