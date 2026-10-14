import type { Db, Queryable } from "../db.js";
import { isUniqueViolation } from "../db.js";
import { badRequest, forbidden, notFound } from "../http/errors.js";
import type { ConversationDto, MemberDto, Role } from "../types.js";

export interface Membership {
  role: Role;
  lastReadSeq: number;
}

export async function getMembership(q: Queryable, conversationId: string, userId: string): Promise<Membership | null> {
  const { rows } = await q.query(
    "SELECT role, last_read_seq FROM conversation_members WHERE conversation_id = $1 AND user_id = $2",
    [conversationId, userId],
  );
  return rows[0] ? { role: rows[0].role, lastReadSeq: rows[0].last_read_seq } : null;
}

/**
 * The single membership gate. Every read or write of a conversation's data goes
 * through this (or a query that joins conversation_members for the caller).
 * Non-members get 404, the same answer as for an id that does not exist.
 */
export async function requireMember(q: Queryable, conversationId: string, userId: string): Promise<Membership> {
  const m = await getMembership(q, conversationId, userId);
  if (!m) throw notFound("Conversation not found");
  return m;
}

export async function requireAdmin(q: Queryable, conversationId: string, userId: string): Promise<Membership> {
  const m = await requireMember(q, conversationId, userId);
  if (m.role !== "admin") throw forbidden("Only group admins can do that");
  return m;
}

export async function memberIds(q: Queryable, conversationId: string): Promise<string[]> {
  const { rows } = await q.query("SELECT user_id FROM conversation_members WHERE conversation_id = $1", [conversationId]);
  return rows.map((r) => r.user_id as string);
}

/**
 * Conversations `userId` belongs to, newest activity first, each from that user's
 * point of view (their role, read position and unread count).
 */
export async function listConversations(q: Queryable, userId: string, onlyIds?: string[]): Promise<ConversationDto[]> {
  const { rows } = await q.query(
    `SELECT c.id, c.type, c.name, c.avatar_url, c.last_seq, c.rev, c.last_message_at, c.created_at, c.ai_enabled,
            me.role, me.last_read_seq,
            (SELECT count(*) FROM messages m
              WHERE m.conversation_id = c.id AND m.seq > me.last_read_seq
                AND m.kind = 'user' AND m.deleted_at IS NULL
                AND m.sender_id IS DISTINCT FROM me.user_id
                -- Messages in a topic this member muted do not count, unless they mention
                -- the member, or the member has switched topic mute off altogether.
                AND (m.topic_id IS NULL
                     OR NOT coalesce((viewer.smart->>'topicMute')::boolean, true)
                     OR NOT EXISTS (SELECT 1 FROM topic_mutes tm WHERE tm.user_id = me.user_id AND tm.topic_id = m.topic_id)
                     OR EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.user_id = me.user_id))) AS unread_count,
            (SELECT coalesce(array_agg(tm.topic_id), '{}')
               FROM topic_mutes tm JOIN topics t ON t.id = tm.topic_id
              WHERE tm.user_id = me.user_id AND t.conversation_id = c.id
                AND coalesce((viewer.smart->>'topicMute')::boolean, true)) AS muted_topic_ids,
            (SELECT json_build_object(
                      'id', m.id, 'seq', m.seq, 'senderId', m.sender_id, 'kind', m.kind,
                      'text', left(m.text, 160), 'hasImage', m.image_url IS NOT NULL,
                      'deleted', m.deleted_at IS NOT NULL, 'createdAt', m.created_at)
               FROM messages m WHERE m.conversation_id = c.id ORDER BY m.seq DESC LIMIT 1) AS last_message
       FROM conversation_members me
       JOIN conversations c ON c.id = me.conversation_id
       JOIN users viewer ON viewer.id = me.user_id
      WHERE me.user_id = $1 AND ($2::uuid[] IS NULL OR c.id = ANY($2))
      ORDER BY c.last_message_at DESC`,
    [userId, onlyIds ?? null],
  );
  if (rows.length === 0) return [];

  const members = await q.query(
    `SELECT cm.conversation_id, cm.role, cm.last_read_seq, u.id, u.username, u.full_name, u.avatar_url
       FROM conversation_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id = ANY($1)
      ORDER BY cm.joined_at, u.username`,
    [rows.map((r) => r.id)],
  );
  const byConversation = new Map<string, MemberDto[]>();
  for (const m of members.rows) {
    const list = byConversation.get(m.conversation_id) ?? [];
    list.push({
      id: m.id,
      username: m.username,
      fullName: m.full_name,
      avatarUrl: m.avatar_url,
      role: m.role,
      lastReadSeq: m.last_read_seq,
    });
    byConversation.set(m.conversation_id, list);
  }

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    avatarUrl: r.avatar_url,
    lastSeq: r.last_seq,
    rev: r.rev,
    lastMessageAt: r.last_message_at,
    createdAt: r.created_at,
    myRole: r.role,
    myLastReadSeq: r.last_read_seq,
    unreadCount: r.unread_count,
    aiEnabled: r.ai_enabled,
    mutedTopicIds: r.muted_topic_ids,
    lastMessage: r.last_message,
    members: byConversation.get(r.id) ?? [],
  }));
}

export async function getConversation(q: Queryable, userId: string, conversationId: string): Promise<ConversationDto> {
  const [conversation] = await listConversations(q, userId, [conversationId]);
  if (!conversation) throw notFound("Conversation not found");
  return conversation;
}

const dmKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** The one DM between two users, created on first use. Safe against concurrent calls. */
export async function findOrCreateDm(db: Db, userId: string, otherId: string): Promise<{ id: string; created: boolean }> {
  if (userId === otherId) throw badRequest("You cannot start a chat with yourself");
  const key = dmKey(userId, otherId);
  const existing = await db.query("SELECT id FROM conversations WHERE dm_key = $1", [key]);
  if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
  try {
    return await db.tx(async (q) => {
      const { rows } = await q.query(
        "INSERT INTO conversations (type, dm_key, created_by) VALUES ('dm', $1, $2) RETURNING id",
        [key, userId],
      );
      const id = rows[0]!.id as string;
      await q.query(
        "INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)",
        [id, userId, otherId],
      );
      return { id, created: true };
    });
  } catch (err) {
    if (!isUniqueViolation(err, "conversations_dm_key_key")) throw err;
    const again = await db.query("SELECT id FROM conversations WHERE dm_key = $1", [key]);
    return { id: again.rows[0]!.id, created: false };
  }
}

export async function createGroup(db: Db, creatorId: string, name: string, otherMemberIds: string[]): Promise<string> {
  return db.tx(async (q) => {
    const { rows } = await q.query(
      "INSERT INTO conversations (type, name, created_by) VALUES ('group', $1, $2) RETURNING id",
      [name, creatorId],
    );
    const id = rows[0]!.id as string;
    await q.query("INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'admin')", [id, creatorId]);
    const others = [...new Set(otherMemberIds)].filter((u) => u !== creatorId);
    if (others.length > 0) {
      await q.query(
        "INSERT INTO conversation_members (conversation_id, user_id) SELECT $1, unnest($2::uuid[])",
        [id, others],
      );
    }
    return id;
  });
}

/** Move a member's read position forward (never back). Returns the new position. */
export async function markRead(q: Queryable, conversationId: string, userId: string, seq: number): Promise<number | null> {
  const { rows } = await q.query(
    `UPDATE conversation_members cm
        SET last_read_seq = LEAST($3::bigint, c.last_seq)
       FROM conversations c
      WHERE c.id = cm.conversation_id AND cm.conversation_id = $1 AND cm.user_id = $2
        AND cm.last_read_seq < LEAST($3::bigint, c.last_seq)
      RETURNING cm.last_read_seq`,
    [conversationId, userId, seq],
  );
  return rows[0]?.last_read_seq ?? null;
}

// ---------------------------------------------------------------------------
// Group administration. Each function runs in one transaction, writes a system
// line into the chat, and returns that line's message id so the caller can emit it.
// ---------------------------------------------------------------------------

export const MAX_GROUP_MEMBERS = 200;

async function requireGroup(q: Queryable, conversationId: string): Promise<void> {
  // Locks the conversation: membership changes are applied one at a time.
  const { rows } = await q.query("SELECT type FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
  if (rows[0]?.type !== "group") throw badRequest("That only works in a group");
}

const nameOf = async (q: Queryable, userId: string): Promise<string> =>
  (await q.query("SELECT full_name FROM users WHERE id = $1", [userId])).rows[0]?.full_name ?? "Someone";

/**
 * A system line such as "Asha added Ben". Takes the next seq and rev like any other
 * message. The caller must already hold the conversation's row lock.
 */
export async function systemLine(q: Queryable, conversationId: string, actorId: string | null, text: string): Promise<string> {
  const { rows } = await q.query(
    `WITH next AS (
       UPDATE conversations SET last_seq = last_seq + 1, rev = rev + 1, last_message_at = now()
        WHERE id = $1 RETURNING last_seq, rev)
     INSERT INTO messages (id, conversation_id, seq, rev, sender_id, kind, text)
     SELECT gen_random_uuid(), $1, next.last_seq, next.rev, $2, 'system', $3 FROM next
     RETURNING id`,
    [conversationId, actorId, text],
  );
  return rows[0]!.id;
}

export async function renameGroup(db: Db, conversationId: string, actorId: string, name: string): Promise<string | null> {
  return db.tx(async (q) => {
    await requireAdmin(q, conversationId, actorId);
    await requireGroup(q, conversationId);
    const { rowCount } = await q.query("UPDATE conversations SET name = $2 WHERE id = $1 AND name IS DISTINCT FROM $2", [conversationId, name]);
    if (!rowCount) return null;
    return systemLine(q, conversationId, actorId, `${await nameOf(q, actorId)} renamed the group to "${name}"`);
  });
}

export async function setGroupAvatar(db: Db, conversationId: string, actorId: string, url: string): Promise<string> {
  return db.tx(async (q) => {
    await requireAdmin(q, conversationId, actorId);
    await requireGroup(q, conversationId);
    await q.query("UPDATE conversations SET avatar_url = $2 WHERE id = $1", [conversationId, url]);
    return systemLine(q, conversationId, actorId, `${await nameOf(q, actorId)} changed the group photo`);
  });
}

async function insertMember(q: Queryable, conversationId: string, userId: string): Promise<boolean> {
  const count = await q.query("SELECT count(*) AS n FROM conversation_members WHERE conversation_id = $1", [conversationId]);
  if (count.rows[0]!.n >= MAX_GROUP_MEMBERS) throw badRequest(`A group can have at most ${MAX_GROUP_MEMBERS} members`);
  // A new member starts with everything before now marked as read.
  const { rowCount } = await q.query(
    `INSERT INTO conversation_members (conversation_id, user_id, last_read_seq)
     SELECT c.id, $2, c.last_seq FROM conversations c WHERE c.id = $1
     ON CONFLICT DO NOTHING`,
    [conversationId, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function addMember(db: Db, conversationId: string, actorId: string, userId: string): Promise<string | null> {
  return db.tx(async (q) => {
    await requireAdmin(q, conversationId, actorId);
    await requireGroup(q, conversationId);
    if (!(await insertMember(q, conversationId, userId))) return null;
    return systemLine(q, conversationId, actorId, `${await nameOf(q, actorId)} added ${await nameOf(q, userId)}`);
  });
}

export interface RemovalResult {
  messageId: string | null;
  /** True when the last member left and the group was deleted. */
  deleted: boolean;
}

/** Remove someone else (admins only) or leave (anyone). */
export async function removeMember(db: Db, conversationId: string, actorId: string, userId: string): Promise<RemovalResult> {
  return db.tx(async (q) => {
    const actor = await requireMember(q, conversationId, actorId);
    await requireGroup(q, conversationId);
    const leaving = actorId === userId;
    if (!leaving && actor.role !== "admin") throw forbidden("Only group admins can do that");
    const target = leaving ? actor : await getMembership(q, conversationId, userId);
    if (!target) throw notFound("That person is not in this group");

    const who = await nameOf(q, userId);
    await q.query("DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2", [conversationId, userId]);

    const remaining = await q.query(
      "SELECT user_id, role FROM conversation_members WHERE conversation_id = $1 ORDER BY joined_at, user_id",
      [conversationId],
    );
    if (remaining.rows.length === 0) {
      await q.query("DELETE FROM conversations WHERE id = $1", [conversationId]);
      return { messageId: null, deleted: true };
    }
    // A group must always have an admin: hand it to the longest-standing member.
    if (!remaining.rows.some((r) => r.role === "admin")) {
      await q.query("UPDATE conversation_members SET role = 'admin' WHERE conversation_id = $1 AND user_id = $2", [
        conversationId,
        remaining.rows[0]!.user_id,
      ]);
    }
    const text = leaving ? `${who} left` : `${await nameOf(q, actorId)} removed ${who}`;
    return { messageId: await systemLine(q, conversationId, actorId, text), deleted: false };
  });
}

export async function setRole(db: Db, conversationId: string, actorId: string, userId: string, role: Role): Promise<string | null> {
  return db.tx(async (q) => {
    await requireAdmin(q, conversationId, actorId);
    await requireGroup(q, conversationId);
    const target = await getMembership(q, conversationId, userId);
    if (!target) throw notFound("That person is not in this group");
    if (target.role === role) return null;
    if (role === "member") {
      const admins = await q.query("SELECT count(*) AS n FROM conversation_members WHERE conversation_id = $1 AND role = 'admin'", [conversationId]);
      if (admins.rows[0]!.n <= 1) throw badRequest("A group needs at least one admin");
    }
    await q.query("UPDATE conversation_members SET role = $3 WHERE conversation_id = $1 AND user_id = $2", [conversationId, userId, role]);
    const [actor, who] = [await nameOf(q, actorId), await nameOf(q, userId)];
    return systemLine(q, conversationId, actorId, role === "admin" ? `${actor} made ${who} an admin` : `${actor} removed ${who} as admin`);
  });
}

/** Join through an invite link. Returns the conversation and the system line, if newly joined. */
export async function acceptInvite(db: Db, token: string, userId: string): Promise<{ conversationId: string; messageId: string | null }> {
  return db.tx(async (q) => {
    const { rows } = await q.query(
      "SELECT id, conversation_id FROM group_invites WHERE token = $1 AND revoked_at IS NULL AND expires_at > now()",
      [token],
    );
    const invite = rows[0];
    if (!invite) throw notFound("That invite link is not valid any more");
    await requireGroup(q, invite.conversation_id);
    if (!(await insertMember(q, invite.conversation_id, userId))) return { conversationId: invite.conversation_id, messageId: null };
    await q.query("UPDATE group_invites SET uses = uses + 1 WHERE id = $1", [invite.id]);
    const messageId = await systemLine(q, invite.conversation_id, userId, `${await nameOf(q, userId)} joined with an invite link`);
    return { conversationId: invite.conversation_id, messageId };
  });
}
