import { toBlocks } from "@/lib/prose/blocks";
import { eyebrowClass } from "@/lib/ui";
import { ShareFrame } from "./chrome";
import type { SharedSynthesisView } from "./types";

/**
 * A signed-off write-up, read by somebody outside the lab.
 *
 * The consent model here is the sign-off itself, and it is worth naming what
 * that buys: unlike a page of margin notes, nothing on this page needs a
 * per-author gate, because the thing being shared is a document a person with
 * the authority to speak for the lab read, edited and put their name behind.
 * It is also why the backend refuses to render this at all if the sign-off has
 * been withdrawn or if any note it was checked against has been — see
 * `approvedWriteUp`. There is no banner over stale prose out here, because
 * there is nobody to ask about it and no line to strike.
 *
 * The draft the model produced is not on this page and cannot be. Only the
 * approved copy travels.
 */
export function SharedSynthesis({ shared }: { shared: SharedSynthesisView }) {
  const approved = new Date(shared.approvedAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <ShareFrame labName={shared.labName}>
      <main className="mx-auto max-w-3xl px-6 py-12">
        <p className={eyebrowClass}>What we worked out</p>
        <h1 className="mt-3 font-serif text-2xl leading-tight text-ink-strong">
          {shared.sessionTitle ?? shared.paperTitle}
        </h1>
        <p className="mt-2 font-serif text-sm text-ink-muted">
          {shared.sessionTitle === undefined ? null : (
            <span>{shared.paperTitle} · </span>
          )}
          <span>Signed off {approved}</span>
        </p>

        <div className="mt-10 flex flex-col gap-5">
          {toBlocks(shared.text).map((block, index) => {
            if (block.kind === "heading") {
              return (
                <h2 key={index} className={eyebrowClass}>
                  {block.text}
                </h2>
              );
            }
            if (block.kind === "list") {
              return (
                <ul key={index} className="flex flex-col gap-3">
                  {block.items.map((item, position) => (
                    <li
                      key={position}
                      className="max-w-prose border-l-2 border-rule pl-3.5 font-serif text-base leading-relaxed text-ink"
                    >
                      {item}
                    </li>
                  ))}
                </ul>
              );
            }
            return (
              <p
                key={index}
                className="max-w-prose font-serif text-base leading-relaxed text-ink"
              >
                {block.text}
              </p>
            );
          })}
        </div>
      </main>
    </ShareFrame>
  );
}
