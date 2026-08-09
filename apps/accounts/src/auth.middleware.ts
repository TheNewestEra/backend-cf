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
import type {Context} from "hono";
import {currentUserVia, logInVia, logOutVia} from "@game-worker/shared/session";
import type {AccountsSessionRpc} from "@game-worker/shared/rpc-types";
import type {Database} from "@game-worker/shared/db";
import {createSession, deleteSession, getUserBySession} from "./account.service";

function directSessionRpc(db: Database): AccountsSessionRpc {
    return {
        getUserBySession: (token) => getUserBySession(db, token),
        createSession: (userId) => createSession(db, userId),
        deleteSession: (token) => deleteSession(db, token),
    };
}

export const currentUser = (c: Context<{ Bindings: Env }>) =>
    currentUserVia(c, directSessionRpc(c.env.DB));

export const logIn = (c: Context<{ Bindings: Env }>, userId: string) =>
    logInVia(c, directSessionRpc(c.env.DB), userId);

export const logOut = (c: Context<{ Bindings: Env }>) =>
    logOutVia(c, directSessionRpc(c.env.DB));
