// Simplified local auth: an account is a username plus a server-generated
// 6-digit login code. There's no external issuer anymore — this table is
// the source of truth for both credentials and the friends/groups module's
// {id, username} lookups. Sessions are opaque tokens stored in `sessions`,
// not JWTs, so a logout (or an admin revoke) is just a row delete.
//
// This is the only service that ever writes `users`/`sessions` — every
// other Worker reaches these through the `AccountsService` RPC entrypoint
// (see index.ts) instead of a direct D1 binding to these two tables.
// Every query below goes through Drizzle (see ./db/schema.ts, ./db/client)
// rather than raw `db.prepare(...).bind(...)` calls — callers pass a `Db`
// (built via `createDb()`), not the raw D1 binding.
//
// Known limitation, acceptable for now: a 6-digit code is only ~1e6
// possibilities, so this has no brute-force throttling. Fine for a
// pre-launch simplification; would need rate-limiting before this is
// exposed to real accounts worth protecting.

import {err, ok, type Result} from "neverthrow";
import {and, eq, gt, inArray} from "drizzle-orm";
import {generateColor} from "@game-worker/shared/color";
import type {UserSchema} from "./account.schema";
import type {z} from "@hono/zod-openapi";
import type {Db} from "./db/client";
import {sessions, users} from "./db/schema";

export type UserRecord = z.infer<typeof UserSchema>;

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days, matches the cookie maxAge

export async function getUserById(db: Db, id: string): Promise<UserRecord | null> {
    const row = await db
        .select({id: users.id, username: users.username, color: users.color})
        .from(users)
        .where(eq(users.id, id))
        .get();
    return row ?? null;
}

export async function findUserByUsername(db: Db, username: string): Promise<UserRecord | null> {
    const row = await db
        .select({id: users.id, username: users.username, color: users.color})
        .from(users)
        .where(eq(users.usernameLower, username.trim().toLowerCase()))
        .get();
    return row ?? null;
}

/** Batch counterpart to `getUserById` — every other service that used to
 * read `users` directly for display-name/color joins (`leaderboard`,
 * `friends`) now goes through this instead, one round trip per request
 * rather than N. An empty `ids` short-circuits rather than handing
 * `inArray` an empty list. */
export async function getUsersByIds(db: Db, ids: string[]): Promise<UserRecord[]> {
    if (ids.length === 0) return [];
    return db
        .select({id: users.id, username: users.username, color: users.color})
        .from(users)
        .where(inArray(users.id, ids));
}

// --- account creation / login -----------------------------------------

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

export function validateUsername(raw: string): Result<string, string> {
    const username = raw.trim();
    if (!USERNAME_PATTERN.test(username)) {
        return err("Username must be 3-20 characters: letters, numbers, or underscores.");
    }
    return ok(username);
}

function generateCode(): string {
    // Zero-padded 6-digit code, e.g. "004821".
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    return ((n ?? 0) % 1_000_000).toString().padStart(6, "0");
}

// generateColor() moved to @game-worker/shared/color — Piece Puzzle and
// Guess the Prompt need the exact same "stable, readable random color" for
// anonymous participants, so it's no longer private to this file. Stored at
// registration and never regenerated here, so a logged-in user's color
// stays stable everywhere it's shown.

async function hashCode(code: string, salt: string): Promise<string> {
    const data = new TextEncoder().encode(`${salt}:${code}`);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Creates an account and returns the plaintext login code — the only time
 * it's ever available. The caller must show it to the user immediately.
 * Composes `validateUsername()`'s sync `Result` with the async uniqueness
 * check/insert the same way `apps/puzzle`'s DO methods compose a sync
 * validation `Result` before doing their own async work: validate first and
 * bail out early via the already-built `Err`, then fold the async
 * uniqueness check into a further `Err`/`Ok` before finally writing the
 * row. */
export async function createAccount(
    db: Db,
    rawUsername: string,
): Promise<Result<{user: UserRecord; code: string}, string>> {
    const validated = validateUsername(rawUsername);
    if (validated.isErr()) return err(validated.error);
    const username = validated.value;

    const existing = await findUserByUsername(db, username);
    if (existing) return err("That username is taken.");

    const id = crypto.randomUUID();
    const code = generateCode();
    const salt = crypto.randomUUID();
    const codeHash = await hashCode(code, salt);
    const color = generateColor();

    await db.insert(users).values({
        id,
        username,
        usernameLower: username.toLowerCase(),
        codeHash,
        codeSalt: salt,
        color,
        createdAt: Date.now(),
    });

    return ok({user: {id, username, color}, code});
}

/** Verifies a username + 6-digit code pair, returning the user on success. */
export async function verifyCode(
    db: Db,
    rawUsername: string,
    rawCode: string,
): Promise<UserRecord | null> {
    const username = rawUsername.trim();
    const code = rawCode.trim();
    if (!username || !/^\d{6}$/.test(code)) return null;

    const row = await db
        .select({
            id: users.id,
            username: users.username,
            color: users.color,
            codeHash: users.codeHash,
            codeSalt: users.codeSalt,
        })
        .from(users)
        .where(eq(users.usernameLower, username.toLowerCase()))
        .get();
    if (!row) return null;

    const candidateHash = await hashCode(code, row.codeSalt);
    if (candidateHash !== row.codeHash) return null;

    return {id: row.id, username: row.username, color: row.color};
}

// --- sessions ------------------------------------------------------------

export async function createSession(db: Db, userId: string): Promise<string> {
    const token = crypto.randomUUID();
    const now = Date.now();
    await db
        .insert(sessions)
        .values({token, userId, createdAt: now, expiresAt: now + SESSION_TTL_MS});
    return token;
}

export async function getUserBySession(db: Db, token: string): Promise<UserRecord | null> {
    const row = await db
        .select({id: users.id, username: users.username, color: users.color})
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.token, token), gt(sessions.expiresAt, Date.now())))
        .get();
    return row ?? null;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.token, token));
}
