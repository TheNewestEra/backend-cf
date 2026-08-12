export const SESSION_COOKIE = "session";

const COOKIE_DOMAIN = ".ryanb.co.za"

export function sessionCookieOpts(allowInsecureLocalDev: boolean) {
    return {
        path: "/",
        domain: allowInsecureLocalDev ? undefined : COOKIE_DOMAIN,
        httpOnly: true,
        secure: true,
        sameSite: allowInsecureLocalDev? "none": "Lax",
        maxAge: 60 * 60 * 24 * 30,
    } as const;
}

export const sessionCookieDeleteOpts = (allowInsecureLocalDev: boolean) => ({
    path: "/",
    domain: allowInsecureLocalDev ? undefined : COOKIE_DOMAIN,
} as const);
