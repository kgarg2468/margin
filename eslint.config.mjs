import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

/**
 * The `events` table is an append-only ledger — the invariant the whole
 * provenance story rests on. Two lint rules keep it that way.
 *
 * A perfect rule would forbid `ctx.db.patch(someEventId, ...)` anywhere, but
 * `patch`/`replace`/`delete` take only a document id, so the table is invisible
 * to a syntactic matcher; knowing it would need type information. What *is*
 * visible is `ctx.db.insert("events", ...)`, which names the table. So instead
 * of policing the whole codebase imperfectly, we narrow the surface: every
 * ledger write must go through `convex/lib/ledger.ts`, and that one file may
 * not mutate anything. Together those two make "append-only" enforceable.
 */
const LEDGER_INSERT_SELECTOR =
  "CallExpression[callee.property.name='insert'][arguments.0.value='events']";

const DB_MUTATION_SELECTOR =
  "MemberExpression[object.property.name='db']" +
  ":matches([property.name='patch'], [property.name='replace'], [property.name='delete'])";

/**
 * The query cache is opt-in at the call site, which makes it easy to lose.
 *
 * `ConvexQueryCacheProvider` only publishes a registry on a React context;
 * `convex/react`'s `useQuery` knows nothing about that context, so a component
 * that imports it — which is what every editor autoimport suggests — silently
 * drops out of the cache and goes back to flashing a skeleton on every
 * navigation. Nothing about the code looks wrong, and nothing fails. So the
 * convention is enforced rather than documented. `useMutation` and `useAction`
 * are unaffected and still come from `convex/react`.
 */
const CACHED_USE_QUERY_MESSAGE =
  "Import useQuery from 'convex-helpers/react/cache/hooks' instead. " +
  "The one in convex/react does not read ConvexQueryCacheProvider's registry, " +
  "so its subscription dies on unmount and the surface re-flashes its skeleton " +
  "on every navigation. useMutation and useAction still come from convex/react.";

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "convex/_generated/**",
    ],
  },
  {
    // `lib/**` as well as `app/**`: a hook lifted out of a route into a shared
    // module is exactly the move that would carry the wrong import somewhere
    // nothing is watching, and it would then be wrong for every caller at once.
    files: ["app/**/*.ts", "app/**/*.tsx", "lib/**/*.ts", "lib/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "convex/react",
              importNames: ["useQuery"],
              message: CACHED_USE_QUERY_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    files: ["convex/**/*.ts"],
    ignores: ["convex/lib/ledger.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: LEDGER_INSERT_SELECTOR,
          message:
            "Write ledger events through recordEvent() in convex/lib/ledger.ts, not ctx.db.insert(\"events\", ...). One write path is what makes the append-only claim auditable.",
        },
      ],
    },
  },
  {
    files: ["convex/lib/ledger.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: DB_MUTATION_SELECTOR,
          message:
            "convex/lib/ledger.ts is the only module that writes the append-only events table, so it may only insert. Nothing updates or deletes a ledger row.",
        },
      ],
    },
  },
];

export default eslintConfig;
