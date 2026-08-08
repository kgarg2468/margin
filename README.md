# margin

**The collective intelligence layer for research groups.**

Margin is a collaborative journal-club and annotation platform. A lab, reading
group, or research team brings in the papers it is reading, annotates them
together in a shared margin, and keeps the discussion attached to the text — so
the questions, objections, and context a group builds up survive past the
meeting they were raised in.

This repo is the web app. It is early: the scaffold, design tokens, and a
placeholder Convex schema are in place; the product surface comes next.

## Stack

| Layer     | Choice                                               |
| --------- | ---------------------------------------------------- |
| Framework | Next.js 15 (App Router) + React 19, Turbopack        |
| Language  | TypeScript (strict)                                  |
| Styling   | Tailwind CSS v4 with semantic CSS custom properties  |
| Backend   | Convex (schema placeholder — not yet provisioned)    |
| Fonts     | Source Serif 4 (reading/headings), Inter (UI chrome) |

## Getting started

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

Other scripts:

```bash
npm run build   # production build
npm run start   # serve the production build
npm run lint    # eslint
```

### Convex

`convex/schema.ts` is a placeholder with no tables. Nothing in the app talks to
Convex yet, so no deployment is needed to run `npm run dev`.

When we are ready to provision a backend:

```bash
npx convex dev
```

That is interactive on first run — it creates the Convex project, writes
`convex.json` and `.env.local`, and generates `convex/_generated/`.

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
app/       # App Router routes, layout, global styles + design tokens
convex/    # Convex backend functions and schema (placeholder)
```
