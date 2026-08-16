// R2-backed image responses shared by every "serve a generated image" route
// (browse's catalog thumbnail, guess's round images, puzzle's source image)
// — all three want the same immutable, long-lived cache policy, since none
// of them ever change the bytes at a given key in place (a regenerate/
// replay always writes a fresh key instead — see each service's own
// image-key helper). Kept as one function so the caching policy can't drift
// between routes.

const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";

export function immutableImageResponse(object: R2ObjectBody): Response {
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Cache-Control", CACHE_CONTROL_IMMUTABLE);
    return new Response(object.body, {headers});
}

// Fronts the three routes above with Cloudflare's edge cache (`caches.default`)
// so a repeat request for the same image URL is served without a Workers
// invocation touching R2 at all — safe here because none of these routes
// vary the bytes by cookie/auth (no `currentUser` involved) and the key
// itself never changes in place, so there's nothing to invalidate later.
// `loadObject` only runs on a cache miss; a null return (not-found) is never
// cached, so a not-yet-generated image keeps getting retried until it exists.
// `ctx` is typed structurally (just the one method used) rather than as
// `ExecutionContext` because Hono's own `c.executionCtx` type of that name
// isn't assignable to the global `@cloudflare/workers-types` one.
export async function cachedImageResponse(
    request: Request,
    ctx: {waitUntil(promise: Promise<unknown>): void},
    loadObject: () => Promise<R2ObjectBody | null>,
): Promise<Response | null> {
    const cache = caches.default;

    const cached = await cache.match(request);
    if (cached) return cached;

    const object = await loadObject();
    if (!object) return null;

    const response = immutableImageResponse(object);
    ctx.waitUntil(cache.put(request, response.clone()));
    return response;
}

// Warms `caches.default` from the write side, at the exact URL a real GET
// against that image route would use — so the *first* real request for a
// just-uploaded image can be a cache hit too, rather than always taking the
// one miss `cachedImageResponse()` above would otherwise absorb. `request`
// must be built the same way the corresponding GET route's own incoming
// request looks (an absolute URL: `new URL(pathFor(...), origin)`), since
// the Cache API matches on that URL alone. Callers own the R2 write itself
// (this only fronts the cache) — pass a second, independent read of the
// same bytes, e.g. one branch of `stream.tee()`, since a stream already
// spent on `R2Bucket.put()` can't be read again.
export async function primeImageCache(
    request: Request,
    body: ReadableStream<Uint8Array>,
    contentType: string,
): Promise<void> {
    const headers = new Headers({
        "content-type": contentType,
        "cache-control": CACHE_CONTROL_IMMUTABLE,
    });
    await caches.default.put(request, new Response(body, {headers}));
}
