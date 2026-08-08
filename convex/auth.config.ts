/**
 * Tells the Convex deployment to trust JWTs minted by Convex Auth itself.
 * `CONVEX_SITE_URL` is provided by Convex; `JWT_PRIVATE_KEY` / `JWKS` are set
 * on the deployment by `npx @convex-dev/auth` (see README).
 */
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
