import { describe, expect, it } from "vitest";
import { inboxState } from "./digest-state";

describe("inboxState", () => {
  it("reserves the slot while the subscription is still out", () => {
    expect(
      inboxState({ loaded: false, catchUpSettled: true, unreadCount: 0 }),
    ).toBe("reserving");
  });

  it("keeps reserving after the query lands, until catchUp has answered", () => {
    // The whole reason this is three states and not two. `digests` resolving
    // to an empty list used to mean "no mail" — but `catchUp` was still out,
    // and it is a mutation that can *build* a digest. The section rendered
    // nothing, the page settled, and then a card appeared mid-read.
    expect(
      inboxState({ loaded: true, catchUpSettled: false, unreadCount: 0 }),
    ).toBe("reserving");
  });

  it("is empty only once both paths have answered", () => {
    expect(
      inboxState({ loaded: true, catchUpSettled: true, unreadCount: 0 }),
    ).toBe("empty");
  });

  it("shows mail that has already arrived without waiting for the mutation", () => {
    // A card in hand fills the slot either way, so holding a ghost over it
    // would only delay something the reader can already act on.
    expect(
      inboxState({ loaded: true, catchUpSettled: false, unreadCount: 2 }),
    ).toBe("showing");
  });

  it("never goes back to reserving once it has shown", () => {
    // Both inputs latch true, so the only transition out of "showing" is to
    // "empty" — which is the fold-away, and is animated.
    expect(
      inboxState({ loaded: true, catchUpSettled: true, unreadCount: 1 }),
    ).toBe("showing");
    expect(
      inboxState({ loaded: true, catchUpSettled: true, unreadCount: 0 }),
    ).toBe("empty");
  });
});
