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
// var (see apps/*/wrangler.jsonc) and passes it in. `allowInsecureLocalDev`
// follows the same pattern: only `accounts` (the one service with a
// Flagship `FLAGS` binding) evaluates the `allow-localhost-cookie` flag and
// passes the result in — see apps/accounts/src/auth.middleware.ts and
// ./cookie. It defaults to `false` so every other service's
// `accountsAuthMiddleware` call site is unaffected.

import type {Context} from "hono";
import {deleteCookie, getCookie, setCookie} from "hono/cookie";
import {parse as parseCookie} from "hono/utils/cookie";
import {SESSION_COOKIE, sessionCookieDeleteOpts, sessionCookieOpts} from "./cookie";
import type {AccountRecord, AccountsSessionRpc} from "./rpc-types";

/** Accounts are optional everywhere except the friends/invites API, so this
 * returns `null` rather than rejecting when there's no session. */
export async function currentUserVia(
    c: Context,
    accounts: AccountsSessionRpc,
    allowInsecureLocalDev = false,
): Promise<AccountRecord | null> {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return null;

    const user = await accounts.getUserBySession(token);
    if (!user) {
        deleteCookie(c, SESSION_COOKIE, sessionCookieDeleteOpts(allowInsecureLocalDev));
        return null;
    }
    return user;
}

/** Same as `currentUserVia`, but for callers with a raw `Request` instead of
 * a Hono `Context` — namely a Durable Object's `fetch()`, which has no
 * request/response cycle to hang a `deleteCookie` on. Used to resolve
 * identity once at WebSocket-upgrade time (the only point a WS connection
 * ever carries the session cookie — individual messages sent over the
 * socket afterwards don't), then kept for the lifetime of that connection
 * via `WebSocket.serializeAttachment` rather than re-resolved per message.
 * A stale/revoked session just resolves to `null` here (nothing to clear a
 * cookie on), same effective behavior as `currentUserVia` from the caller's
 * point of view. */
export async function currentUserFromRequestVia(
    request: Request,
    accounts: AccountsSessionRpc,
): Promise<AccountRecord | null> {
    const header = request.headers.get("Cookie");
    if (!header) return null;
    const token = parseCookie(header, SESSION_COOKIE)[SESSION_COOKIE];
    if (!token) return null;

    return accounts.getUserBySession(token);
}

export async function logInVia(
    c: Context,
    accounts: AccountsSessionRpc,
    userId: string,
    allowInsecureLocalDev = false,
): Promise<void> {
    const token = await accounts.createSession(userId);
    setCookie(c, SESSION_COOKIE, token, sessionCookieOpts(allowInsecureLocalDev));
}

export async function logOutVia(
    c: Context,
    accounts: AccountsSessionRpc,
    allowInsecureLocalDev = false,
): Promise<void> {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await accounts.deleteSession(token);
    deleteCookie(c, SESSION_COOKIE, sessionCookieDeleteOpts(allowInsecureLocalDev));
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
        currentUserFromRequest: (request: Request, env: Env) => currentUserFromRequestVia(request, env.ACCOUNTS),
        logIn: (c: Context<{ Bindings: Env }>, userId: string) => logInVia(c, c.env.ACCOUNTS, userId),
        logOut: (c: Context<{ Bindings: Env }>) => logOutVia(c, c.env.ACCOUNTS),
    };
}
