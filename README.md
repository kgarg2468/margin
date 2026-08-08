# margin

**The collective intelligence layer for research groups.**

Margin is a collaborative journal-club and annotation platform. A lab, reading
group, or research team brings in the papers it is reading, annotates them
together in a shared margin, and keeps the discussion attached to the text — so
the questions, objections, and context a group builds up survive past the
meeting they were raised in.

This repo is the web app. It is early: the full data model, email/password
auth, labs with invite codes, and the authenticated app shell are in place.
Papers, the reader, sessions, and digests come next.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design — the
append-only Ledger, passage anchoring, the digest policy, and the privacy
constitution.

## Stack

| Layer     | Choice                                               |
| --------- | ---------------------------------------------------- |
| Framework | Next.js 15 (App Router) + React 19, Turbopack        |
| Language  | TypeScript (strict)                                  |
| Styling   | Tailwind CSS v4 with semantic CSS custom properties  |
| Backend   | Convex — database, file storage, actions, scheduler  |
| Auth      | Convex Auth, Password provider (email + password)    |
| Fonts     | Source Serif 4 (reading/headings), Inter (UI chrome) |

## Getting started

You need two terminals: one running the Convex backend, one running Next.js.

```bash
npm install

# terminal 1 — provisions the deployment on first run, then watches convex/
# and keeps convex/_generated/ up to date
npx convex dev

# terminal 2
npm run dev
```

Then open http://localhost:3000.

`npx convex dev` is interactive the first time: it creates the Convex project,
writes `convex.json`, and puts `CONVEX_DEPLOYMENT` and `NEXT_PUBLIC_CONVEX_URL`
into `.env.local`. See [`.env.example`](.env.example) for what ends up there.

Then set up auth on the deployment once — this generates the RS256 key pair
Convex Auth signs its JWTs with and sets `JWT_PRIVATE_KEY`, `JWKS`, and
`SITE_URL`:

```bash
npx @convex-dev/auth
```

Other scripts:

```bash
npm run build   # production build
npm run start   # serve the production build
npm run lint    # eslint
npx tsc --noEmit
```

### Generated Convex types

`convex/_generated/` is committed, because `tsc --noEmit` in CI has no
deployment to generate it from. `npx convex dev` rewrites it whenever
`convex/` changes; if you need to regenerate it without a deployment, run
`npx convex codegen`.

## Design system

Design tokens live in [`app/globals.css`](app/globals.css). The visual target is
a well-kept lab notebook: warm sand paper, espresso ink, a single Wedgwood-blue
accent for anything interactive, and a muted violet reserved for synthesis
surfaces. Dark mode is a deep warm brown-black with sand-toned ink.

Tokens are semantic rather than literal — components should use `bg-page`,
`bg-surface`, `text-ink`, `text-ink-muted`, `border-rule`, `bg-accent`,
`text-secondary`, and `bg-highlight` instead of raw hex, so themes flip for
free. Light/dark follows `prefers-color-scheme`; adding `.dark` to `<html>`
forces dark mode if we later ship an explicit toggle.

Typography is serif-led: `font-serif` for anything you read or write,
`font-sans` for chrome, labels, and controls.

## Layout

```
app/           # App Router routes, layout, global styles + design tokens
  signin/      # email + password sign-in / sign-up
  app/         # the authenticated shell (sidebar, lab overview, onboarding)
convex/        # Convex schema, auth config, and backend functions
  lib/         # authz + ledger helpers, not Convex functions themselves
  _generated/  # generated types, committed
docs/          # architecture notes
lib/           # shared front-end helpers
middleware.ts  # redirects /app <-> /signin based on session
```
