import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Router, type Response } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import type { Ctx } from "../ctx.js";
import { isUniqueViolation } from "../db.js";
import { HttpError, badRequest, conflict, parse } from "../http/errors.js";
import { limiter, me, requireAuth } from "../http/middleware.js";
import { imageField, storeUploadedImage } from "../uploads/routes.js";
import { smartPatchSchema } from "../users/smart.js";
import { SESSION_COOKIE, createSession, deleteSession, toMe } from "./sessions.js";

const COMMON_PASSWORDS = new Set([
  "1234567890", "12345678910", "0123456789", "0987654321", "1234567891", "qwertyuiop", "password12",
  "password123", "password1234", "passwordpassword", "qwerty12345", "qwerty123456", "1q2w3e4r5t",
  "1q2w3e4r5t6y", "iloveyou123", "abcdefghij", "abc1234567", "1111111111", "0000000000", "letmein123",
]);

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.]{3,24}$/, "Username must be 3-24 characters: letters, digits, underscore or dot");

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  // bcrypt only reads the first 72 bytes; refuse longer input rather than silently truncate.
  .refine((p) => Buffer.byteLength(p, "utf8") <= 72, "Password must be at most 72 bytes")
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), "That password is too common");

const signupSchema = z.object({
  email: z.email().max(254).trim().toLowerCase(),
  username: usernameSchema,
  fullName: z.string().trim().min(1, "Name is required").max(80),
  password: passwordSchema,
});

const loginSchema = z.object({
  // Email or username.
  identifier: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(200),
});

export const newInviteCode = () => randomBytes(12).toString("base64url");

export function authRoutes(ctx: Ctx): Router {
  const r = Router();
  const { db, config } = ctx;
  // Compared against when the account does not exist, so "no such user" and "wrong
  // password" take the same time.
  const dummyHash = bcrypt.hashSync("synchat-dummy-password", config.bcryptCost);

  const setSessionCookie = (res: Response, token: string) =>
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      path: "/",
      maxAge: config.sessionTtlMs,
    });

  const signupLimit = limiter(ctx, { windowMs: 60 * 60 * 1000, limit: 10 });
  const loginIpLimit = limiter(ctx, { windowMs: 15 * 60 * 1000, limit: 30 });
  // Failed attempts per account from one address. Keyed on both so an attacker cannot
  // lock a victim out from elsewhere.
  const loginAccountLimit = limiter(ctx, {
    windowMs: 15 * 60 * 1000,
    limit: 8,
    skipSuccessfulRequests: true,
    by: (req) => `${ipKeyGenerator(req.ip ?? "unknown")}|${String(req.body?.identifier ?? "").toLowerCase().slice(0, 254)}`,
  });

  r.post("/signup", signupLimit, async (req, res) => {
    const input = parse(signupSchema, req.body);
    if (input.password.toLowerCase().includes(input.username)) {
      throw badRequest("Invalid input", { formErrors: [], fieldErrors: { password: ["Password must not contain your username"] } });
    }
    const passwordHash = await bcrypt.hash(input.password, config.bcryptCost);
    const row = await db
      .query(
        `INSERT INTO users (email, username, full_name, password_hash, invite_code)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [input.email, input.username, input.fullName, passwordHash, newInviteCode()],
      )
      .then((result) => result.rows[0]!)
      .catch((err: unknown) => {
        if (isUniqueViolation(err, "users_username_key")) throw conflict("That username is taken", { field: "username" });
        if (isUniqueViolation(err, "users_email_key")) throw conflict("An account with that email already exists", { field: "email" });
        throw err;
      });
    const { token } = await createSession(db, row.id, req.headers["user-agent"], config.sessionTtlMs);
    setSessionCookie(res, token);
    res.status(201).json({ user: toMe(row) });
  });

  r.post("/login", loginIpLimit, loginAccountLimit, async (req, res) => {
    const input = parse(loginSchema, req.body);
    const { rows } = await db.query("SELECT * FROM users WHERE email = $1 OR username = $1 LIMIT 1", [input.identifier]);
    const row = rows[0];
    const ok = await bcrypt.compare(input.password, row?.password_hash ?? dummyHash);
    if (!row || !ok) throw new HttpError(401, "invalid_credentials", "Wrong email, username or password");
    const { token } = await createSession(db, row.id, req.headers["user-agent"], config.sessionTtlMs);
    setSessionCookie(res, token);
    res.json({ user: toMe(row) });
  });

  r.post("/logout", requireAuth(ctx), async (req, res) => {
    await deleteSession(db, req.sessionId!);
    ctx.rt.disconnectSession(req.sessionId!);
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: config.cookieSecure, path: "/" });
    res.json({ ok: true });
  });

  r.get("/me", requireAuth(ctx), (req, res) => {
    res.json({ user: me(req) });
  });

  r.patch("/profile", requireAuth(ctx), async (req, res) => {
    const { fullName } = parse(z.object({ fullName: z.string().trim().min(1, "Name is required").max(80) }), req.body);
    const { rows } = await db.query("UPDATE users SET full_name = $2 WHERE id = $1 RETURNING *", [me(req).id, fullName]);
    res.json({ user: toMe(rows[0]) });
  });

  r.post("/avatar", requireAuth(ctx), limiter(ctx, { windowMs: 60 * 1000, limit: 10, by: "user" }), imageField, async (req, res) => {
    const image = await storeUploadedImage(ctx, req);
    const { rows } = await db.query("UPDATE users SET avatar_url = $2 WHERE id = $1 RETURNING *", [me(req).id, image.url]);
    res.json({ user: toMe(rows[0]) });
  });

  /** Switch smart features on or off for myself. */
  r.patch("/smart", requireAuth(ctx), async (req, res) => {
    const patch = parse(smartPatchSchema, req.body);
    // Stored sparsely: only what has been switched off. The change is applied to the
    // stored value in one statement, so two switches flipped at the same moment
    // cannot overwrite each other.
    const off = Object.fromEntries(Object.entries(patch).filter(([, on]) => on === false));
    const on = Object.entries(patch).filter(([, value]) => value === true).map(([feature]) => feature);
    const { rows } = await db.query("UPDATE users SET smart = (smart || $2::jsonb) - $3::text[] WHERE id = $1 RETURNING *", [me(req).id, JSON.stringify(off), on]);
    const user = toMe(rows[0]);
    // Unread counts depend on the mute switch; other devices should follow at once.
    ctx.rt.toUsers([user.id], "me:updated", { user });
    res.json({ user });
  });

  /** Replace my personal invite link. The old one stops working at once. */
  r.post("/invite-code", requireAuth(ctx), async (req, res) => {
    const { rows } = await db.query("UPDATE users SET invite_code = $2 WHERE id = $1 RETURNING *", [me(req).id, newInviteCode()]);
    res.json({ user: toMe(rows[0]) });
  });

  return r;
}
