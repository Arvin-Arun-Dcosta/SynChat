import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../ctx.js";
import { HttpError, forbidden, parse } from "../http/errors.js";
import { limiter, me, requireAuth } from "../http/middleware.js";
import { DigestUnavailable } from "./model.js";
import type { DigestService } from "./service.js";

/** The LLM-backed features exist only on a server with an API key. */
export function requireDigest(ctx: Ctx): DigestService {
  if (!ctx.digest) throw new HttpError(503, "ai_unavailable", "AI features are not configured on this server");
  return ctx.digest;
}

/** The inbox of questions waiting on me, across all my chats. */
export function inboxRoutes(ctx: Ctx): Router {
  const r = Router();
  r.use(requireAuth(ctx));

  r.get("/", async (req, res) => {
    const user = me(req);
    if (!user.smart.inbox) throw forbidden("The questions inbox is switched off in your settings");
    res.json({ questions: await requireDigest(ctx).inbox(user.id) });
  });

  r.post("/:id/dismiss", async (req, res) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    await requireDigest(ctx).dismiss(id, me(req).id);
    res.json({ ok: true });
  });

  return r;
}

/** Topic-level AI actions; mounted under /api/topics next to the lane corrections. */
export function digestTopicRoutes(ctx: Ctx): Router {
  const r = Router();
  r.use(requireAuth(ctx));
  const idParams = z.object({ id: z.uuid() });
  // Each call may cost a model request, so this is tighter than other limits.
  const digestLimit = limiter(ctx, { windowMs: 60 * 1000, limit: 12, by: "user" });

  /** Bring a topic's digest up to date now (catch-up on demand). */
  r.post("/:id/digest", digestLimit, async (req, res) => {
    const { id } = parse(idParams, req.params);
    try {
      res.json(await requireDigest(ctx).refresh(id, me(req).id));
    } catch (err) {
      if (err instanceof DigestUnavailable) throw new HttpError(502, "ai_error", err.message);
      throw err;
    }
  });

  /** Override decided/open by hand; `status: null` hands it back to the digest. */
  r.patch("/:id/status", async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ status: z.enum(["open", "decided"]).nullable(), outcome: z.string().trim().max(200).nullish() }), req.body);
    res.json(await requireDigest(ctx).setStatus(id, me(req).id, body.status, body.outcome?.trim() || null));
  });

  return r;
}
