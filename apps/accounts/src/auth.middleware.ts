// Auth flow: create an account with just a username, get back a one-time
// 6-digit login code, log back in later with username + code. No external
// issuer — see account.service.ts for the credential/session model.
//
// This is the *owning* service's version — it talks to D1 directly, since
// it's the source of truth for `sessions`. Every other service's
// `auth.middleware.ts` is the RPC-backed equivalent, built on
// `@game-worker/shared/session` against the `ACCOUNTS` service binding.

import type {Context} from "hono";
import {deleteCookie, getCookie, setCookie} from "hono/cookie";
import {createSession, deleteSession, getUserBySession, type UserRecord} from "./account.service";

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
export async function currentUser(c: Context<{ Bindings: Env }>): Promise<UserRecord | null> {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return null;

    const user = await getUserBySession(c.env.DB, token);
    if (!user) {
        deleteCookie(c, SESSION_COOKIE, {path: "/"});
        return null;
    }
    return user;
}

export async function logIn(c: Context<{ Bindings: Env }>, userId: string): Promise<void> {
    const token = await createSession(c.env.DB, userId);
    setCookie(c, SESSION_COOKIE, token, COOKIE_OPTS);
}

export async function logOut(c: Context<{ Bindings: Env }>): Promise<void> {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deleteSession(c.env.DB, token);
    deleteCookie(c, SESSION_COOKIE, {path: "/"});
}
