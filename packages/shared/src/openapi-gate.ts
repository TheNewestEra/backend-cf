import type {MiddlewareHandler} from "hono";

// One Cloudflare Flagship boolean flag, read by every service off the same
// "timer" Flagship app they already share (see each wrangler.jsonc's
// `flagship` block) — flip it off there for the production environment to
// pull `/openapi.json` and the Swagger UI at `/docs` off the public
// internet, with no redeploy. Defaults to enabled so dev/staging need no
// dashboard change to keep working.
const OPENAPI_ROUTES_FLAG = "openapi-routes-enabled";

/** Mount ahead of `app.doc("/openapi.json", ...)` and
 * `app.get("/docs", swaggerUI(...))` in each service's index.ts (same
 * paths, registered first — see any service for the exact wiring). 404s
 * exactly as if the routes were never registered, rather than exposing
 * them and blocking the response some other way. Untyped bindings (like
 * @game-worker/shared/cors' `corsMiddleware`) so it drops into any
 * service's `OpenAPIHono<{Bindings: Env}>` regardless of that Env's other
 * bindings — every Env here does carry `FLAGS: Flagship` though. */
export const openApiRoutesGate: MiddlewareHandler = async (c, next) => {
    const enabled = await c.env.FLAGS.getBooleanValue(OPENAPI_ROUTES_FLAG, true);
    if (!enabled) return c.notFound();
    await next();
};
