// Session-cookie helpers shared by every service except `accounts` itself
// (which owns the `sessions` table directly and doesn't need to go over
// RPC to read it — see apps/accounts/src/auth.middleware.ts). Everywhere
// else, `currentUser()` used to query D1 directly; now that accounts is
// its own Worker, that lookup is a service-binding/RPC call instead — see
// each service's `auth.middleware.ts`, which just plugs its `ACCOUNTS`
// binding into the functions below. Only `accounts` ever sets/clears the
// cookie itself (on login/register/logout); everywhere else just reads it
// — see ./cookie for why it's scoped to be visible across every service's
// subdomain rather than staying local to whichever Worker set it.
//
// `cookieDomain` is threaded through as a plain argument (rather than read
// off `c.env` in here) so this file stays agnostic of any particular
// service's `Env` shape — each caller pulls its own `c.env.COOKIE_DOMAIN`
// var (see apps/*/wrangler.jsonc) and passes it in.

import type {Context} from "hono";
import {deleteCookie, getCookie, setCookie} from "hono/cookie";
import {SESSION_COOKIE, sessionCookieDeleteOpts, sessionCookieOpts} from "./cookie";
import type {AccountRecord, AccountsSessionRpc} from "./rpc-types";

/** Accounts are optional everywhere except the friends/invites API, so this
 * returns `null` rather than rejecting when there's no session. */
export async function currentUserVia(
    c: Context,
    accounts: AccountsSessionRpc
): Promise<AccountRecord | null> {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return null;

    const user = await accounts.getUserBySession(token);
    if (!user) {
        deleteCookie(c, SESSION_COOKIE, sessionCookieDeleteOpts());
        return null;
    }
    return user;
}

export async function logInVia(
    c: Context,
    accounts: AccountsSessionRpc,
    userId: string,
): Promise<void> {
    const token = await accounts.createSession(userId);
    setCookie(c, SESSION_COOKIE, token, sessionCookieOpts());
}

export async function logOutVia(c: Context, accounts: AccountsSessionRpc): Promise<void> {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await accounts.deleteSession(token);
    deleteCookie(c, SESSION_COOKIE, sessionCookieDeleteOpts());
}

/** Builds the `currentUser`/`logIn`/`logOut` trio every non-accounts
 * service's `auth.middleware.ts` re-exports, bound to that Worker's own
 * `ACCOUNTS` binding — was copy-pasted identically into `friends`, `guess`,
 * `leaderboard`, and `puzzle` before this existed. `Env` is each caller's
 * own ambient `Env` (see `worker-configuration.d.ts`), passed explicitly as
 * a type argument since it's declared globally per-app and can't be
 * inferred from here. */
export function accountsAuthMiddleware<Env extends { ACCOUNTS: AccountsSessionRpc }>() {
    return {
        currentUser: (c: Context<{ Bindings: Env }>) => currentUserVia(c, c.env.ACCOUNTS),
        logIn: (c: Context<{ Bindings: Env }>, userId: string) => logInVia(c, c.env.ACCOUNTS, userId),
        logOut: (c: Context<{ Bindings: Env }>) => logOutVia(c, c.env.ACCOUNTS),
    };
}
