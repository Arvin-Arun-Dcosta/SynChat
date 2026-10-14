import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../ctx.js";
import { forbidden, parse } from "../http/errors.js";
import { limiter, me, requireAuth } from "../http/middleware.js";
import { search } from "./service.js";

export function searchRoutes(ctx: Ctx): Router {
  const r = Router();
  r.use(requireAuth(ctx));
  const searchLimit = limiter(ctx, { windowMs: 60 * 1000, limit: 40, by: "user" });

  r.get("/", searchLimit, async (req, res) => {
    const user = me(req);
    if (!user.smart.search) throw forbidden("Search is switched off in your settings");
    const { q, limit } = parse(z.object({ q: z.string().trim().min(2, "Type at least two characters").max(200), limit: z.coerce.number().int().min(1).max(50).default(30) }), req.query);
    res.json(await search(ctx.db, ctx.embedder, user.id, q, limit));
  });

  return r;
}
