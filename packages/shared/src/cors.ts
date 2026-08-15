import {cors} from "hono/cors";

const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*ryanb\.co\.za$|^http:\/\/localhost:4200$/i;

export const corsMiddleware = cors({
    origin: (origin) => (origin && ALLOWED_ORIGIN.test(origin) ? origin : null),
    credentials: true,
});
