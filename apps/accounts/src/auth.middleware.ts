// Auth flow: create an account with just a username, get back a one-time
// 6-digit login code, log back in later with username + code. No external
// issuer — see account.service.ts for the credential/session model.
//
// This is the *owning* service's version — it talks to D1 directly, since
// it's the source of truth for `sessions`. `AccountsSessionRpc` is a
// structural interface though (not tied to the real RPC stub), so a plain
// object closing over `c.env.DB` satisfies it just as well as the RPC
// binding every other service uses — letting this reuse the exact same
// `currentUserVia`/`logInVia`/`logOutVia` from `@game-worker/shared/session`
// instead of a second copy of that logic. Only the session lookup itself
// differs: an in-process D1 query here vs. an RPC call everywhere else.
//
// `allow-localhost-cookie` is a Flagship boolean flag (see `FLAGS` binding
// in wrangler.jsonc) — when enabled it relaxes the session cookie's
// `Secure`/`Domain` so it round-trips against a `wrangler dev` Worker on
// plain HTTP for the Angular app at http://localhost:4200 (see
// @game-worker/shared/cookie). Leave it disabled everywhere else.
import type {Context} from "hono";
import {currentUserVia, logInVia, logOutVia} from "@game-worker/shared/session";
import type {AccountsSessionRpc} from "@game-worker/shared/rpc-types";
import {createSession, deleteSession, getUserBySession} from "./account.service";
import {createDb, type Db} from "./db/client";

function directSessionRpc(db: Db): AccountsSessionRpc {
    return {
        getUserBySession: (token) => getUserBySession(db, token),
        createSession: (userId) => createSession(db, userId),
        deleteSession: (token) => deleteSession(db, token),
    };
}

const allowLocalhostCookie = (c: Context<{ Bindings: Env }>) =>
    c.env.FLAGS.getBooleanValue("allow-localhost-cookie", false);

export const currentUser = async (c: Context<{ Bindings: Env }>) =>
    currentUserVia(c, directSessionRpc(createDb(c.env.DB)), await allowLocalhostCookie(c));

export const logIn = async (c: Context<{ Bindings: Env }>, userId: string) =>
    logInVia(c, directSessionRpc(createDb(c.env.DB)), userId, await allowLocalhostCookie(c));

export const logOut = async (c: Context<{ Bindings: Env }>) =>
    logOutVia(c, directSessionRpc(createDb(c.env.DB)), await allowLocalhostCookie(c));
