// Simplified local auth: an account is a username plus a server-generated
// 6-digit login code. There's no external issuer anymore — this table is
// the source of truth for both credentials and the friends/groups module's
// {id, username} lookups. Sessions are opaque tokens stored in `sessions`,
// not JWTs, so a logout (or an admin revoke) is just a row delete.
//
// This is the only service that ever writes `users`/`sessions` — every
// other Worker reaches these through the `AccountsService` RPC entrypoint
// (see index.ts) instead of a direct D1 binding to these two tables.
//
// Known limitation, acceptable for now: a 6-digit code is only ~1e6
// possibilities, so this has no brute-force throttling. Fine for a
// pre-launch simplification; would need rate-limiting before this is
// exposed to real accounts worth protecting.

import type {Database} from "@game-worker/shared/db";
import {generateColor} from "@game-worker/shared/color";
import type {UserSchema} from "./account.schema";
import type {z} from "@hono/zod-openapi";

export type UserRecord = z.infer<typeof UserSchema>;

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days, matches the cookie maxAge

export async function getUserById(db: Database, id: string): Promise<UserRecord | null> {
    const row = await db.prepare("SELECT id, username, color FROM users WHERE id = ?").bind(id).first<UserRecord>();
    return row ?? null;
}

export async function findUserByUsername(db: Database, username: string): Promise<UserRecord | null> {
    const row = await db
        .prepare("SELECT id, username, color FROM users WHERE username_lower = ?")
        .bind(username.trim().toLowerCase())
        .first<UserRecord>();
    return row ?? null;
}

// --- account creation / login -----------------------------------------

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

export function validateUsername(raw: string): { ok: true; username: string } | { ok: false; error: string } {
    const username = raw.trim();
    if (!USERNAME_PATTERN.test(username)) {
        return {ok: false, error: "Username must be 3-20 characters: letters, numbers, or underscores."};
    }
    return {ok: true, username};
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

type CreateAccountResult =
    | { ok: true; user: UserRecord; code: string }
    | { ok: false; error: string };

/** Creates an account and returns the plaintext login code — the only time
 * it's ever available. The caller must show it to the user immediately. */
export async function createAccount(db: Database, rawUsername: string): Promise<CreateAccountResult> {
    const validated = validateUsername(rawUsername);
    if (!validated.ok) return validated;
    const {username} = validated;

    const existing = await findUserByUsername(db, username);
    if (existing) return {ok: false, error: "That username is taken."};

    const id = crypto.randomUUID();
    const code = generateCode();
    const salt = crypto.randomUUID();
    const codeHash = await hashCode(code, salt);
    const color = generateColor();

    await db
        .prepare(
            `INSERT INTO users (id, username, username_lower, code_hash, code_salt, color, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, username, username.toLowerCase(), codeHash, salt, color, Date.now())
        .run();

    return {ok: true, user: {id, username, color}, code};
}

interface CredentialRow {
    id: string;
    username: string;
    color: string;
    code_hash: string;
    code_salt: string;
}

/** Verifies a username + 6-digit code pair, returning the user on success. */
export async function verifyCode(db: Database, rawUsername: string, rawCode: string): Promise<UserRecord | null> {
    const username = rawUsername.trim();
    const code = rawCode.trim();
    if (!username || !/^\d{6}$/.test(code)) return null;

    const row = await db
        .prepare("SELECT id, username, color, code_hash, code_salt FROM users WHERE username_lower = ?")
        .bind(username.toLowerCase())
        .first<CredentialRow>();
    if (!row) return null;

    const candidateHash = await hashCode(code, row.code_salt);
    if (candidateHash !== row.code_hash) return null;

    return {id: row.id, username: row.username, color: row.color};
}

// --- sessions ------------------------------------------------------------

export async function createSession(db: Database, userId: string): Promise<string> {
    const token = crypto.randomUUID();
    const now = Date.now();
    await db
        .prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(token, userId, now, now + SESSION_TTL_MS)
        .run();
    return token;
}

export async function getUserBySession(db: Database, token: string): Promise<UserRecord | null> {
    const row = await db
        .prepare(
            `SELECT u.id, u.username, u.color
             FROM sessions s
                      JOIN users u ON u.id = s.user_id
             WHERE s.token = ?
               AND s.expires_at > ?`,
        )
        .bind(token, Date.now())
        .first<UserRecord>();
    return row ?? null;
}

export async function deleteSession(db: Database, token: string): Promise<void> {
    await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}
