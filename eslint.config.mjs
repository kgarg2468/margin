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
