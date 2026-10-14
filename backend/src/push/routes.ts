import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../ctx.js";
import { HttpError, parse } from "../http/errors.js";
import { limiter, me, requireAuth } from "../http/middleware.js";

const subscriptionSchema = z.object({
  // Push services are public HTTPS endpoints; refuse anything else so the server
  // cannot be pointed at an internal address.
  endpoint: z.url({ protocol: /^https$/ }).max(1000),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
});

export function pushRoutes(ctx: Ctx): Router {
  const r = Router();
  r.use(requireAuth(ctx));
  const limit = limiter(ctx, { windowMs: 60 * 1000, limit: 20, by: "user" });
  const requirePush = () => {
    if (!ctx.push) throw new HttpError(503, "push_unavailable", "Notifications are not configured on this server");
  };

  /** Register this browser for notifications. */
  r.post("/subscribe", limit, async (req, res) => {
    requirePush();
    const sub = parse(subscriptionSchema, req.body);
    // An endpoint belongs to one browser; if someone else was signed in there before, it is now mine.
    await ctx.db.query(
      `INSERT INTO push_subscriptions (user_id, session_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [me(req).id, req.sessionId, sub.endpoint, sub.keys.p256dh, sub.keys.auth],
    );
    res.status(201).json({ ok: true });
  });

  r.post("/unsubscribe", limit, async (req, res) => {
    const { endpoint } = parse(z.object({ endpoint: z.string().max(1000) }), req.body);
    await ctx.db.query("DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2", [endpoint, me(req).id]);
    res.json({ ok: true });
  });

  return r;
}
