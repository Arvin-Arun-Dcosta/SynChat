import { Router } from "express";
import { z } from "zod";
import { usernameSchema } from "../auth/routes.js";
import type { Ctx } from "../ctx.js";
import { notFound, parse } from "../http/errors.js";
import { limiter, requireAuth } from "../http/middleware.js";
import type { PublicUser } from "../types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toPublicUser(row: any): PublicUser {
  return { id: row.id, username: row.username, fullName: row.full_name, avatarUrl: row.avatar_url };
}

/**
 * Finding people. There is deliberately no listing or prefix search: you can only
 * resolve a username you already know in full, or an invite code someone gave you.
 */
export function userRoutes(ctx: Ctx): Router {
  const r = Router();
  r.use(requireAuth(ctx));
  const lookupLimit = limiter(ctx, { windowMs: 60 * 1000, limit: 30, by: "user" });

  r.get("/lookup", lookupLimit, async (req, res) => {
    const { username } = parse(z.object({ username: usernameSchema }), req.query);
    const { rows } = await ctx.db.query("SELECT id, username, full_name, avatar_url FROM users WHERE username = $1", [username]);
    if (!rows[0]) throw notFound("No user with that username");
    res.json({ user: toPublicUser(rows[0]) });
  });

  r.get("/invite/:code", lookupLimit, async (req, res) => {
    const { code } = parse(z.object({ code: z.string().min(8).max(64) }), req.params);
    const { rows } = await ctx.db.query("SELECT id, username, full_name, avatar_url FROM users WHERE invite_code = $1", [code]);
    if (!rows[0]) throw notFound("That invite link is not valid");
    res.json({ user: toPublicUser(rows[0]) });
  });

  return r;
}
