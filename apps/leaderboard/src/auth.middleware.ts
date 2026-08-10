// Thin per-service wrapper around @game-worker/shared/session, bound to
// this Worker's ACCOUNTS service binding. See account.service.ts / the
// AccountsService RPC entrypoint in apps/accounts for what actually backs
// these calls — this Worker no longer queries `sessions` directly.

import {accountsAuthMiddleware} from "@game-worker/shared/session";

export const {currentUser, logIn, logOut} = accountsAuthMiddleware<Env>();
