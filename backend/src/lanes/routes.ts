import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../ctx.js";
import { HttpError, parse } from "../http/errors.js";
import { limiter, me, requireAuth } from "../http/middleware.js";
import { getConversation } from "../conversations/service.js";
import { requireTopicAccess, type LaneService } from "./service.js";

const idParams = z.object({ id: z.uuid() });
export const topicTitle = z.string().trim().min(1, "A topic needs a name").max(80);

export function requireLanes(ctx: Ctx): LaneService {
  if (!ctx.lanes) throw new HttpError(503, "lanes_disabled", "Topic lanes are not enabled on this server");
  return ctx.lanes;
}

/** Corrections to a topic as a whole. Membership is checked inside each service call. */
export function topicRoutes(ctx: Ctx): Router {
  const r = Router();
  r.use(requireAuth(ctx));
  const changeLimit = limiter(ctx, { windowMs: 10 * 1000, limit: 30, by: "user" });

  r.patch("/:id", changeLimit, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const { title } = parse(z.object({ title: topicTitle }), req.body);
    res.json(await requireLanes(ctx).renameTopic(id, me(req).id, title));
  });

  /**
   * Mute or unmute a topic for myself. Nobody else is affected or told. Works even if
   * lane assignment is off on this server: the topics already exist.
   */
  r.put("/:id/mute", changeLimit, async (req, res) => {
    const user = me(req);
    const { id } = parse(idParams, req.params);
    const { muted } = parse(z.object({ muted: z.boolean() }), req.body);
    const { conversationId } = await requireTopicAccess(ctx.db, id, user.id);
    if (muted) await ctx.db.query("INSERT INTO topic_mutes (user_id, topic_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [user.id, id]);
    else await ctx.db.query("DELETE FROM topic_mutes WHERE user_id = $1 AND topic_id = $2", [user.id, id]);
    // My other devices follow, and get the recounted unread badge.
    const conversation = await getConversation(ctx.db, user.id, conversationId);
    ctx.rt.toUsers([user.id], "topic:mute", { conversationId, topicId: id, muted });
    ctx.rt.toUsers([user.id], "conversation:updated", { conversation });
    res.json({ conversationId, topicId: id, muted, conversation });
  });

  r.post("/:id/merge", changeLimit, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const { intoTopicId } = parse(z.object({ intoTopicId: z.uuid() }), req.body);
    res.json(await requireLanes(ctx).mergeTopics(id, intoTopicId, me(req).id));
  });

  return r;
}
