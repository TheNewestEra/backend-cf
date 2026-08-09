// Thin per-service wrapper around @game-worker/shared/session, bound to
// this Worker's ACCOUNTS service binding. See account.service.ts / the
// AccountsService RPC entrypoint in apps/accounts for what actually backs
// these calls — this Worker no longer queries `sessions` directly.

import type {Context} from "hono";
import {currentUserVia, logInVia, logOutVia} from "@game-worker/shared/session";

export const currentUser = (c: Context<{ Bindings: Env }>) => currentUserVia(c, c.env.ACCOUNTS);
export const logIn = (c: Context<{ Bindings: Env }>, userId: string) => logInVia(c, c.env.ACCOUNTS, userId);
export const logOut = (c: Context<{ Bindings: Env }>) => logOutVia(c, c.env.ACCOUNTS);
