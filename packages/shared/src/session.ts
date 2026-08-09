// Session-cookie helpers shared by every service except `accounts` itself
// (which owns the `sessions` table directly and doesn't need to go over
// RPC to read it — see apps/accounts/src/auth.middleware.ts). Everywhere
// else, `currentUser()` used to query D1 directly; now that accounts is
// its own Worker, that lookup is a service-binding/RPC call instead — see
// each service's `auth.middleware.ts`, which just plugs its `ACCOUNTS`
// binding into the functions below. The cookie itself stays local to
// whichever Worker is handling the request, since that's the one writing
// the response.

import type {Context} from "hono";
import {deleteCookie, getCookie, setCookie} from "hono/cookie";
import type {AccountRecord, AccountsSessionRpc} from "./rpc-types";

const SESSION_COOKIE = "session";
const COOKIE_OPTS = {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 30,
} as const;

/** Accounts are optional everywhere except the friends/invites API, so this
 * returns `null` rather than rejecting when there's no session. */
export async function currentUserVia(c: Context, accounts: AccountsSessionRpc): Promise<AccountRecord | null> {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return null;

    const user = await accounts.getUserBySession(token);
    if (!user) {
        deleteCookie(c, SESSION_COOKIE, {path: "/"});
        return null;
    }
    return user;
}

export async function logInVia(c: Context, accounts: AccountsSessionRpc, userId: string): Promise<void> {
    const token = await accounts.createSession(userId);
    setCookie(c, SESSION_COOKIE, token, COOKIE_OPTS);
}

export async function logOutVia(c: Context, accounts: AccountsSessionRpc): Promise<void> {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await accounts.deleteSession(token);
    deleteCookie(c, SESSION_COOKIE, {path: "/"});
}
