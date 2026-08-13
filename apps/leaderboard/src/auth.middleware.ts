import {accountsAuthMiddleware} from "@game-worker/shared/session";

export const {currentUser} = accountsAuthMiddleware<Env>();
