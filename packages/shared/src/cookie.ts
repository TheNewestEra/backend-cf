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

export const sessionCookieDeleteOpts = () => ({path: "/", domain: COOKIE_DOMAIN} as const);
