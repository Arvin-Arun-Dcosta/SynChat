import { createHash, randomBytes } from "node:crypto";
import { parseCookie } from "cookie";
import type { Queryable } from "../db.js";
import type { Me } from "../types.js";
import { smartOf } from "../users/smart.js";

export const SESSION_COOKIE = "sid";
const TOUCH_AFTER_MS = 60 * 60 * 1000;

export interface SessionInfo {
  sessionId: string;
  user: Me;
}

const hashToken = (token: string): Buffer => createHash("sha256").update(token).digest();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toMe(row: any): Me {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    fullName: row.full_name,
    avatarUrl: row.avatar_url,
    inviteCode: row.invite_code,
    createdAt: row.created_at,
    smart: smartOf(row.smart),
  };
}

export async function createSession(
  q: Queryable,
  userId: string,
  userAgent: string | undefined,
  ttlMs: number,
): Promise<{ token: string; sessionId: string }> {
  const token = randomBytes(32).toString("base64url");
  const { rows } = await q.query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval) RETURNING id`,
    [userId, hashToken(token), userAgent?.slice(0, 300) ?? null, String(ttlMs)],
  );
  return { token, sessionId: rows[0]!.id };
}

/** Resolve a session token to its user, or null if it is unknown or expired. */
export async function findSession(q: Queryable, token: string | undefined, ttlMs: number): Promise<SessionInfo | null> {
  if (!token || token.length > 200) return null;
  const { rows } = await q.query(
    `SELECT s.id AS session_id, s.last_seen_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  // Sliding expiry, written at most once an hour per session.
  if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_AFTER_MS) {
    q.query(
      `UPDATE sessions SET last_seen_at = now(), expires_at = now() + ($2 || ' milliseconds')::interval WHERE id = $1`,
      [row.session_id, String(ttlMs)],
    ).catch(() => {});
  }
  return { sessionId: row.session_id, user: toMe(row) };
}

export async function deleteSession(q: Queryable, sessionId: string): Promise<void> {
  await q.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
}

export function tokenFromCookieHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  try {
    return parseCookie(header)[SESSION_COOKIE];
  } catch {
    return undefined;
  }
}
