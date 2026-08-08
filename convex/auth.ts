import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import type { DataModel } from "./_generated/dataModel";

/**
 * Email + password only. No external identity provider, no email delivery
 * dependency — a PI can get their lab in without waiting on anyone's IT
 * department. Passwords are hashed with Scrypt by Convex Auth.
 *
 * The `profile` hook is what lets sign-up capture a display name, which the
 * member list and every annotation byline need.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password<DataModel>({
      profile(params) {
        const email = (params.email as string).trim().toLowerCase();
        const name = (params.name as string | undefined)?.trim();
        return {
          email,
          // Fall back to the local part of the email so bylines are never blank.
          name: name && name.length > 0 ? name : email.split("@")[0] || email,
        };
      },
    }),
  ],
});
