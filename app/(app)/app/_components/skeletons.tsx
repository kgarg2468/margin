import { skeletonClass } from "@/lib/ui";

/**
 * The page's shape before its data.
 *
 * Every list in the app is the same typographic object — a serif title line
 * over a sans meta line, ruled apart — so one ghost fits all of them. The
 * blocks breathe (see `margin-breathe`) with a small stagger down the page,
 * and the whole thing is one `status` region so a screen reader hears
 * "Loading" once, not a shape at a time.
 */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex flex-col gap-2 border-b border-rule py-4 first:border-t last:border-b"
          style={{ animationDelay: `${i * 140}ms` }}
        >
          <span
            aria-hidden
            className={`${skeletonClass} h-6 w-3/5`}
            style={{ animationDelay: `${i * 140}ms` }}
          />
          <span
            aria-hidden
            className={`${skeletonClass} h-4 w-2/5`}
            style={{ animationDelay: `${i * 140 + 70}ms` }}
          />
        </div>
      ))}
    </div>
  );
}

/** A whole page still arriving: the header rule, a title, a list below it. */
export function PageSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-10">
      <div className="flex flex-col gap-3 border-l border-rule pl-6">
        <span aria-hidden className={`${skeletonClass} h-10 w-48`} />
        <span
          aria-hidden
          className={`${skeletonClass} h-4 w-64`}
          style={{ animationDelay: "70ms" }}
        />
      </div>
      <ListSkeleton rows={3} />
    </div>
  );
}
