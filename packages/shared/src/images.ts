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
