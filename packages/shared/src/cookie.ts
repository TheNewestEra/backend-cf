// Session cookie name/options. The domain is deliberately NOT hardcoded
// here — it's supplied by the caller (each service's own `COOKIE_DOMAIN`
// var, see apps/*/wrangler.jsonc) so dev/staging/production can each point
// at their own value from config instead of a code change + redeploy of
// every service. In practice all three environments use the same
// `.ryanb.co.za` today (every service's custom domain ends in it — see
// @game-worker/shared/cors for the matching origin allowlist), but nothing
// here assumes that.

export const SESSION_COOKIE = "session";

const COOKIE_DOMAIN = ".ryanb.co.za"

export function sessionCookieOpts() {
    return {
        path: "/",
        domain: COOKIE_DOMAIN,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        maxAge: 60 * 60 * 24 * 30,
    } as const;
}

// deleteCookie must be called with the same path+domain used to set the
// cookie, or it clears a different (non-existent) host-only cookie and
// leaves the real one behind.
export const sessionCookieDeleteOpts = () => ({path: "/", domain: COOKIE_DOMAIN} as const);
