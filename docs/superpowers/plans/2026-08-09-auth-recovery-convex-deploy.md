# Auth Recovery and Convex Deployment Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make an expired Convex session recoverable from the app error boundary and ensure every Vercel production build deploys the matching Convex backend before building Next.js.

**Architecture:** Replace the error boundary's passive `/signin` link with a client recovery action that calls Convex Auth `signOut()`, waits for its cookie-clearing response, and then performs a full document navigation to `/signin`. Configure Vercel's build command to run `convex deploy` with the target deployment URL injected into `NEXT_PUBLIC_CONVEX_URL`, then run the existing Next.js build against that exact backend.

**Tech Stack:** Next.js 15, React 19, Convex Auth, Convex CLI, Vercel, Vitest, Playwright.

## Global Constraints

- Preserve invite and normal sign-in behavior.
- Recovery must clear both the Convex Auth cookie and the browser-side Convex query state.
- Recovery must still reach `/signin` if the backend already rejects the session.
- The Vercel build must stop if the Convex deployment fails and must build Next.js with the URL of the deployment it just updated.
- Do not add Google OAuth or migrate hosting providers in this change.
- Do not alter unrelated user work.

### Task 1: Recover cleanly from an expired session

**Files:**
- Create: `lib/auth/session-recovery.ts`
- Create: `lib/auth/session-recovery.test.ts`
- Modify: `app/(app)/error.tsx`

**Step 1: Write the failing test**

Add a focused unit test proving that recovery waits for the supplied sign-out action and navigates to `/signin` afterward, including when sign-out resolves after an already-invalid backend session.

**Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/auth/session-recovery.test.ts`

Expected: FAIL because the recovery helper does not exist yet.

**Step 3: Write the minimal implementation**

Implement the tested orchestration helper. In the error boundary, use `useAuthActions().signOut`, disable the recovery button while it is running, and perform `window.location.assign("/signin")` only after sign-out completes. Keep the existing `Try again` behavior.

**Step 4: Run the focused and browser tests**

Run: `npx vitest run lib/auth/session-recovery.test.ts`

Expected: PASS.

Run: `npm run test:e2e`

Expected: PASS.

### Task 2: Couple Vercel and Convex deployment

**Files:**
- Create: `vercel.json`
- Modify: `.env.example`
- Modify: `README.md`

**Step 1: Configure the deployment build**

Set Vercel's build command to:

`npx convex deploy --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL --cmd 'npm run build'`

Document `CONVEX_DEPLOY_KEY` as a Vercel-only secret and explain that the command deploys Convex first and then builds Next.js using that deployment URL.

**Step 2: Validate the configuration locally**

Run a Vercel build or the closest non-mutating build validation available with the linked project configuration. Do not deploy a backend from a placeholder key.

Expected: Vercel accepts the configuration and the normal build remains green.

### Task 3: Configure production and verify end to end

**Files:** None committed; external deployment configuration only.

**Step 1: Create a scoped Convex production deployment token**

Use the authenticated Convex CLI to create a production token specifically for Vercel. Do not print the token into logs or save it in the repository.

**Step 2: Add the token to Vercel production**

Set `CONVEX_DEPLOY_KEY` on the existing `margin` Vercel project for Production only.

**Step 3: Publish through GitHub**

Commit the reviewed changes, push the existing branch, open a PR against `main`, wait for CI and Greptile, resolve actionable findings, and merge.

**Step 4: Verify production**

Confirm the resulting Vercel build runs the Convex deploy command, the production alias serves the new deployment, `/signin` renders, `/app` protects unauthenticated visitors, and the recovery control is present in the production artifact.
