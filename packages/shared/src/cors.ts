// Base CORS policy shared by every service. Sessions ride on a cookie
// (see @game-worker/shared/session), so this has to echo back a specific
// allowed origin with `credentials: true` rather than `*` — a wildcard
// origin can't be paired with credentialed requests per the fetch spec.
//
// Allowed: the production frontend and any of its subdomains
// (`https://*.ryanb.co.za`) plus the local Angular dev server
// (`http://localhost:4200`). Add more allowed origins here, not per-service.

import {cors} from "hono/cors";

const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*ryanb\.co\.za$|^http:\/\/localhost:4200$/i;

export const corsMiddleware = cors({
    origin: (origin) => (origin && ALLOWED_ORIGIN.test(origin) ? origin : null),
    credentials: true,
});
