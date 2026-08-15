// Thin per-service wrapper around @game-worker/shared/session, bound to
// this Worker's ACCOUNTS service binding — see apps/accounts for what
// actually backs these calls.

import {accountsAuthMiddleware} from "@game-worker/shared/session";

export const {currentUser} = accountsAuthMiddleware<Env>();
