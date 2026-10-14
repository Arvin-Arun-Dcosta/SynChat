import { Router } from "express";
import { z } from "zod";
import { MAX_MESSAGE_LENGTH } from "../conversations/routes.js";
import type { Ctx } from "../ctx.js";
import { parse } from "../http/errors.js";
import { limiter, me, requireAuth } from "../http/middleware.js";
import { requireLanes, topicTitle } from "../lanes/routes.js";
import { deleteMessage, editMessage, setReaction } from "./service.js";

const idParams = z.object({ id: z.uuid() });

// One emoji: a pictograph, optionally with modifiers/joiners (skin tone, flags, families).
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}‍️]{0,10}$/u;
const reactionSchema = z.object({ emoji: z.string().max(32).regex(EMOJI, "Not an emoji") });

/** Changes to a single existing message, addressed by its id. */
export function messageRoutes(ctx: Ctx): Router {
  const r = Router();
  const { db, rt } = ctx;
  r.use(requireAuth(ctx));
  const changeLimit = limiter(ctx, { windowMs: 10 * 1000, limit: 40, by: "user" });

  r.patch("/:id", changeLimit, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const { text } = parse(z.object({ text: z.string().trim().min(1, "A message needs some text").max(MAX_MESSAGE_LENGTH) }), req.body);
    const { message, changed } = await editMessage(db, id, me(req).id, text);
    if (changed) {
      await rt.toConversation(message.conversationId, "message:updated", { message });
      ctx.lanes?.messageEdited(message.conversationId, message.id);
    }
    res.json({ message });
  });

  r.delete("/:id", changeLimit, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const { message, changed } = await deleteMessage(db, id, me(req).id);
    if (changed) await rt.toConversation(message.conversationId, "message:updated", { message });
    res.json({ message });
  });

  r.put("/:id/reactions", changeLimit, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const { emoji } = parse(reactionSchema, req.body);
    const { message, changed } = await setReaction(db, id, me(req).id, emoji, true);
    if (changed) await rt.toConversation(message.conversationId, "message:updated", { message });
    res.json({ message });
  });

  r.delete("/:id/reactions", changeLimit, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const { emoji } = parse(reactionSchema, req.body);
    const { message, changed } = await setReaction(db, id, me(req).id, emoji, false);
    if (changed) await rt.toConversation(message.conversationId, "message:updated", { message });
    res.json({ message });
  });

  /** Correct the lane assignment: move this message to another topic, or to a new one. */
  r.post("/:id/topic", changeLimit, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const target = parse(
      z.union([z.object({ topicId: z.uuid() }).strict(), z.object({ title: topicTitle.optional() }).strict()]),
      req.body,
    );
    res.json(await requireLanes(ctx).moveMessage(id, me(req).id, target));
  });

  return r;
}
