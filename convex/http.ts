import { httpRouter } from "convex/server";
import { auth } from "./auth";

/**
 * Convex Auth's HTTP endpoints (token exchange, OAuth callbacks, sign-out)
 * live on the deployment's `.convex.site` origin.
 */
const http = httpRouter();

auth.addHttpRoutes(http);

export default http;
