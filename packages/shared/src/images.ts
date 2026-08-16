// Generated images (browse's catalog thumbnail, guess's round images,
// puzzle's source image) are served straight off R2's own public bucket
// domain now, not proxied through any of these Workers — each app's
// `IMAGES_PUBLIC_URL` var (see its wrangler.jsonc) is the custom domain
// connected to the shared `IMAGES` bucket. This is the one place that turns
// an R2 key into the URL a client actually fetches, so the three call sites
// (catalog.service.ts's `thumbnailUrl`, guess.model.ts's per-round
// `imageUrl`, puzzle.model.ts's `sourceImageUrl`) can't drift on the shape.
export function publicImageUrl(imagesPublicUrl: string, key: string): string {
    return new URL(key, imagesPublicUrl).toString();
}

// Set as `cacheControl` in every `IMAGES.put()`'s `httpMetadata` (see each
// upload site) so a custom domain fronting the bucket caches the object at
// Cloudflare's edge — none of these objects ever change in place, a
// regenerate/replay always writes a fresh key instead (see each service's
// own image-key helper), so there's nothing to invalidate later.
export const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";
