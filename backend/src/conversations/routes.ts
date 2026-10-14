import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { usernameSchema } from "../auth/routes.js";
import type { Ctx } from "../ctx.js";
import { badRequest, notFound, parse } from "../http/errors.js";
import { limiter, me, requireAuth } from "../http/middleware.js";
import { requireDigest } from "../digest/routes.js";
import { listTopics } from "../lanes/service.js";
import { getMessage, listChanges, listMessages, sendMessage } from "../messages/service.js";
import type { InviteDto } from "../types.js";
import { imageField, storeUploadedImage } from "../uploads/routes.js";
import {
  acceptInvite,
  addMember,
  createGroup,
  findOrCreateDm,
  getConversation,
  listConversations,
  markRead,
  memberIds,
  removeMember,
  renameGroup,
  requireAdmin,
  requireMember,
  setGroupAvatar,
  setRole,
} from "./service.js";

const idParams = z.object({ id: z.uuid() });

const dmSchema = z.union([
  z.object({ username: usernameSchema }).strict(),
  z.object({ inviteCode: z.string().min(8).max(64) }).strict(),
  z.object({ userId: z.uuid() }).strict(),
]);

const groupSchema = z.object({
  name: z.string().trim().min(1, "Group name is required").max(80),
  usernames: z.array(usernameSchema).max(50).default([]),
});

export const MAX_MESSAGE_LENGTH = 4000;

const sendSchema = z.object({
  id: z.uuid(),
  text: z.string().max(MAX_MESSAGE_LENGTH).nullish(),
  imageId: z.uuid().nullish(),
  replyToId: z.uuid().nullish(),
  /** Set when sending from inside a lane: the message is pinned to that topic. */
  topicId: z.uuid().nullish(),
});

const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });
const INVITE_TTL_DAYS = 7;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toInvite = (row: any): InviteDto => ({ id: row.id, token: row.token, createdAt: row.created_at, expiresAt: row.expires_at, uses: row.uses });

const pageQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Only messages of one topic lane. */
  topicId: z.uuid().optional(),
});

const changesQuery = z.object({ since: z.coerce.number().int().min(0) });

export function conversationRoutes(ctx: Ctx): Router {
  const r = Router();
  const { db, rt } = ctx;
  r.use(requireAuth(ctx));

  const createLimit = limiter(ctx, { windowMs: 60 * 1000, limit: 20, by: "user" });
  const sendLimit = limiter(ctx, { windowMs: 10 * 1000, limit: 30, by: "user" });

  /** Push a conversation, as each listed user sees it, to those users' devices. */
  const pushConversation = async (conversationId: string, userIds: string[]) => {
    await Promise.all(
      userIds.map(async (userId) => {
        const [conversation] = await listConversations(db, userId, [conversationId]);
        if (conversation) rt.toUsers([userId], "conversation:updated", { conversation });
      }),
    );
  };

  r.get("/", async (req, res) => {
    res.json({ conversations: await listConversations(db, me(req).id) });
  });

  r.post("/dm", createLimit, async (req, res) => {
    const user = me(req);
    const input = parse(dmSchema, req.body);
    let otherId: string | undefined;
    if ("username" in input) {
      otherId = (await db.query("SELECT id FROM users WHERE username = $1", [input.username])).rows[0]?.id;
    } else if ("inviteCode" in input) {
      otherId = (await db.query("SELECT id FROM users WHERE invite_code = $1", [input.inviteCode])).rows[0]?.id;
    } else {
      // A raw user id is only accepted for someone you already share a conversation
      // with; otherwise ids could be used to reach people you were never introduced to.
      const shared = await db.query(
        `SELECT 1 FROM conversation_members a JOIN conversation_members b USING (conversation_id)
          WHERE a.user_id = $1 AND b.user_id = $2 LIMIT 1`,
        [user.id, input.userId],
      );
      otherId = shared.rows[0] ? input.userId : undefined;
    }
    if (!otherId) throw notFound("User not found");
    const { id, created } = await findOrCreateDm(db, user.id, otherId);
    if (created) await pushConversation(id, [user.id, otherId]);
    res.status(created ? 201 : 200).json({ conversation: await getConversation(db, user.id, id) });
  });

  r.post("/group", createLimit, async (req, res) => {
    const user = me(req);
    const input = parse(groupSchema, req.body);
    const wanted = [...new Set(input.usernames)].filter((u) => u !== user.username);
    const found = await db.query("SELECT id, username FROM users WHERE username = ANY($1)", [wanted]);
    const missing = wanted.filter((u) => !found.rows.some((row) => row.username === u));
    if (missing.length > 0) throw badRequest(`No user named ${missing.map((u) => "@" + u).join(", ")}`, { missing });
    const id = await createGroup(db, user.id, input.name, found.rows.map((row) => row.id));
    await pushConversation(id, await memberIds(db, id));
    res.status(201).json({ conversation: await getConversation(db, user.id, id) });
  });

  r.get("/:id", async (req, res) => {
    const { id } = parse(idParams, req.params);
    res.json({ conversation: await getConversation(db, me(req).id, id) });
  });

  r.get("/:id/messages", async (req, res) => {
    const { id } = parse(idParams, req.params);
    const query = parse(pageQuery, req.query);
    await requireMember(db, id, me(req).id);
    res.json(await listMessages(db, id, query));
  });

  /** Everything created or changed since `since`. What a client calls after a reconnect. */
  r.get("/:id/changes", async (req, res) => {
    const { id } = parse(idParams, req.params);
    const { since } = parse(changesQuery, req.query);
    await requireMember(db, id, me(req).id);
    res.json(await listChanges(db, id, since, 500));
  });

  r.post("/:id/messages", sendLimit, async (req, res) => {
    const user = me(req);
    const { id: conversationId } = parse(idParams, req.params);
    const input = parse(sendSchema, req.body);
    const text = input.text?.trim() || null;
    if (!text && !input.imageId) throw badRequest("A message needs text or an image");

    const { message, created } = await sendMessage(db, {
      id: input.id,
      conversationId,
      senderId: user.id,
      text,
      imageId: input.imageId ?? null,
      replyToId: input.replyToId ?? null,
      topicId: input.topicId ?? null,
    });
    if (created) {
      await rt.toConversation(conversationId, "message:new", { message });
      // The message is delivered. Working out its topic happens after, on a queue,
      // and reaches clients as its own event; sending never waits for it.
      if (ctx.lanes) ctx.lanes.messageCreated(conversationId, message.id);
      // Without lanes there is no topic to wait for: notify straight away.
      else void ctx.push?.notifyMessage(message.id).catch(() => {});
    }
    res.status(created ? 201 : 200).json({ message });
  });

  /** The conversation's topic lanes, with this member's unread count for each. */
  r.get("/:id/topics", async (req, res) => {
    const user = me(req);
    const { id } = parse(idParams, req.params);
    const membership = await requireMember(db, id, user.id);
    res.json({ topics: await listTopics(db, id, { viewer: { userId: user.id, lastReadSeq: membership.lastReadSeq } }) });
  });

  r.post("/:id/read", async (req, res) => {
    const user = me(req);
    const { id } = parse(idParams, req.params);
    const { seq } = parse(z.object({ seq: z.number().int().min(0) }), req.body);
    await requireMember(db, id, user.id);
    const lastReadSeq = await markRead(db, id, user.id, seq);
    if (lastReadSeq !== null) {
      await rt.toConversation(id, "read", { conversationId: id, userId: user.id, lastReadSeq });
    }
    res.json({ ok: true });
  });

  // --- Group administration ------------------------------------------------

  /** After a membership or settings change: show the system line, refresh everyone's copy. */
  const announce = async (conversationId: string, messageId: string | null) => {
    if (!messageId) return;
    const message = await getMessage(db, messageId);
    if (message) await rt.toConversation(conversationId, "message:new", { message });
    await pushConversation(conversationId, await memberIds(db, conversationId));
  };

  r.patch("/:id", async (req, res) => {
    const user = me(req);
    const { id } = parse(idParams, req.params);
    const { name } = parse(z.object({ name: z.string().trim().min(1, "Group name is required").max(80) }), req.body);
    await announce(id, await renameGroup(db, id, user.id, name));
    res.json({ conversation: await getConversation(db, user.id, id) });
  });

  r.post("/:id/avatar", createLimit, imageField, async (req, res) => {
    const user = me(req);
    const { id } = parse(idParams, req.params);
    await requireAdmin(db, id, user.id); // before storing anything
    const image = await storeUploadedImage(ctx, req);
    await announce(id, await setGroupAvatar(db, id, user.id, image.url));
    res.json({ conversation: await getConversation(db, user.id, id) });
  });

  r.post("/:id/members", createLimit, async (req, res) => {
    const user = me(req);
    const { id } = parse(idParams, req.params);
    const { username } = parse(z.object({ username: usernameSchema }), req.body);
    await requireAdmin(db, id, user.id); // before revealing whether the username exists
    const found = await db.query("SELECT id FROM users WHERE username = $1", [username]);
    if (!found.rows[0]) throw notFound("No user with that username");
    await announce(id, await addMember(db, id, user.id, found.rows[0].id));
    res.json({ conversation: await getConversation(db, user.id, id) });
  });

  /** Remove a member (admins), or leave (userId is your own id). */
  r.delete("/:id/members/:userId", async (req, res) => {
    const user = me(req);
    const { id, userId } = parse(memberParams, req.params);
    const { messageId, deleted } = await removeMember(db, id, user.id, userId);
    rt.toUsers([userId], "conversation:removed", { conversationId: id });
    if (!deleted) await announce(id, messageId);
    res.json({ ok: true });
  });

  r.patch("/:id/members/:userId", async (req, res) => {
    const user = me(req);
    const { id, userId } = parse(memberParams, req.params);
    const { role } = parse(z.object({ role: z.enum(["admin", "member"]) }), req.body);
    await announce(id, await setRole(db, id, user.id, userId, role));
    res.json({ conversation: await getConversation(db, user.id, id) });
  });

  /**
   * The admin's switch for the LLM-backed features in this group. They send the
   * group's messages to an outside AI provider, so it is off until an admin says so,
   * and flipping it either way is announced in the chat.
   */
  r.patch("/:id/ai", async (req, res) => {
    const user = me(req);
    const { id } = parse(idParams, req.params);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    await requireAdmin(db, id, user.id); // before revealing whether the server has AI at all
    await announce(id, await requireDigest(ctx).setEnabled(id, user.id, enabled));
    res.json({ conversation: await getConversation(db, user.id, id) });
  });

  // --- Invite links (admins) -------------------------------------------------

  r.get("/:id/invites", async (req, res) => {
    const { id } = parse(idParams, req.params);
    await requireAdmin(db, id, me(req).id);
    const { rows } = await db.query(
      "SELECT * FROM group_invites WHERE conversation_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC",
      [id],
    );
    res.json({ invites: rows.map(toInvite) });
  });

  r.post("/:id/invites", createLimit, async (req, res) => {
    const user = me(req);
    const { id } = parse(idParams, req.params);
    await requireAdmin(db, id, user.id);
    const type = await db.query("SELECT type FROM conversations WHERE id = $1", [id]);
    if (type.rows[0]?.type !== "group") throw badRequest("That only works in a group");
    const { rows } = await db.query(
      `INSERT INTO group_invites (conversation_id, token, created_by, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4)) RETURNING *`,
      [id, randomBytes(18).toString("base64url"), user.id, INVITE_TTL_DAYS],
    );
    res.status(201).json({ invite: toInvite(rows[0]) });
  });

  r.delete("/:id/invites/:inviteId", async (req, res) => {
    const { id, inviteId } = parse(z.object({ id: z.uuid(), inviteId: z.uuid() }), req.params);
    await requireAdmin(db, id, me(req).id);
    await db.query("UPDATE group_invites SET revoked_at = now() WHERE id = $1 AND conversation_id = $2", [inviteId, id]);
    res.json({ ok: true });
  });

  return r;
}

/** Following a group invite link. The token is the only thing a non-member needs. */
export function inviteRoutes(ctx: Ctx): Router {
  const r = Router();
  const { db, rt } = ctx;
  r.use(requireAuth(ctx));
  const tokenParams = z.object({ token: z.string().min(16).max(64) });
  const inviteLimit = limiter(ctx, { windowMs: 60 * 1000, limit: 20, by: "user" });

  /** What the link leads to, shown before joining. Reveals only name, photo and size. */
  r.get("/:token", inviteLimit, async (req, res) => {
    const { token } = parse(tokenParams, req.params);
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.avatar_url,
              (SELECT count(*) FROM conversation_members cm WHERE cm.conversation_id = c.id) AS member_count,
              EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = c.id AND cm.user_id = $2) AS already_member
         FROM group_invites i JOIN conversations c ON c.id = i.conversation_id
        WHERE i.token = $1 AND i.revoked_at IS NULL AND i.expires_at > now()`,
      [token, me(req).id],
    );
    if (!rows[0]) throw notFound("That invite link is not valid any more");
    const g = rows[0];
    res.json({ group: { id: g.already_member ? g.id : null, name: g.name, avatarUrl: g.avatar_url, memberCount: g.member_count, alreadyMember: g.already_member } });
  });

  r.post("/:token/accept", inviteLimit, async (req, res) => {
    const user = me(req);
    const { token } = parse(tokenParams, req.params);
    const { conversationId, messageId } = await acceptInvite(db, token, user.id);
    if (messageId) {
      const message = await getMessage(db, messageId);
      if (message) await rt.toConversation(conversationId, "message:new", { message });
      const ids = await memberIds(db, conversationId);
      await Promise.all(
        ids.map(async (userId) => {
          const [conversation] = await listConversations(db, userId, [conversationId]);
          if (conversation) rt.toUsers([userId], "conversation:updated", { conversation });
        }),
      );
    }
    res.json({ conversation: await getConversation(db, user.id, conversationId) });
  });

  return r;
}
