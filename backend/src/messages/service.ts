import type { Db, Queryable } from "../db.js";
import { isUniqueViolation } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../http/errors.js";
import type { ImageDto, MessageDto } from "../types.js";
import { saveMentions } from "./mentions.js";

export const MESSAGE_COLUMNS = `
  m.id, m.conversation_id, m.seq, m.rev, m.sender_id, m.kind, m.text, m.image_url,
  m.image_width, m.image_height, m.created_at, m.edited_at, m.deleted_at, m.topic_id,
  (SELECT coalesce(array_agg(mm.user_id), '{}') FROM message_mentions mm WHERE mm.message_id = m.id) AS mentions,
  (SELECT coalesce(json_agg(json_build_object('emoji', x.emoji, 'userIds', x.user_ids) ORDER BY x.first_at), '[]'::json)
     FROM (SELECT emoji, array_agg(user_id ORDER BY created_at) AS user_ids, min(created_at) AS first_at
             FROM reactions WHERE message_id = m.id GROUP BY emoji) x) AS reactions,
  (SELECT json_build_object(
            'id', r.id, 'senderId', r.sender_id, 'text', left(r.text, 160),
            'hasImage', r.image_url IS NOT NULL, 'deleted', r.deleted_at IS NOT NULL)
     FROM messages r WHERE r.id = m.reply_to_id) AS reply_to`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toMessageDto(row: any): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    rev: row.rev,
    senderId: row.sender_id,
    kind: row.kind,
    text: row.text,
    image: row.image_url ? { url: row.image_url, width: row.image_width, height: row.image_height } : null,
    replyTo: row.reply_to ?? null,
    reactions: row.reactions ?? [],
    topicId: row.topic_id ?? null,
    mentions: row.mentions ?? [],
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deleted: row.deleted_at !== null,
  };
}

export async function getMessage(q: Queryable, id: string): Promise<MessageDto | null> {
  const { rows } = await q.query(`SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.id = $1`, [id]);
  return rows[0] ? toMessageDto(rows[0]) : null;
}

/**
 * Lock the conversation row and take the next rev (and, for a new message, the next
 * seq). Everything that changes a conversation's messages calls this inside its
 * transaction, which is what makes seq and rev gap-free and assigned in commit order.
 */
export async function bump(q: Queryable, conversationId: string, opts: { newMessage: boolean }): Promise<{ seq: number; rev: number }> {
  const { rows } = await q.query(
    opts.newMessage
      ? `UPDATE conversations SET last_seq = last_seq + 1, rev = rev + 1, last_message_at = now()
          WHERE id = $1 RETURNING last_seq, rev`
      : `UPDATE conversations SET rev = rev + 1 WHERE id = $1 RETURNING last_seq, rev`,
    [conversationId],
  );
  if (!rows[0]) throw notFound("Conversation not found");
  return { seq: rows[0].last_seq, rev: rows[0].rev };
}

export interface SendInput {
  id: string;
  conversationId: string;
  senderId: string;
  text: string | null;
  /** Id of an image this sender uploaded earlier. */
  imageId?: string | null;
  replyToId?: string | null;
  /** Sent from inside a lane: pin the message to this topic. */
  topicId?: string | null;
}

/**
 * Store a message. Idempotent on the client-chosen id: sending the same id again
 * returns the stored message with created=false, so a client may retry blindly.
 */
export async function sendMessage(db: Db, input: SendInput): Promise<{ message: MessageDto; created: boolean }> {
  try {
    return await db.tx(async (q) => {
      // Lock first. Sends to one conversation queue up here, so a concurrent retry of
      // the same id waits, then finds the first attempt's row below.
      const member = await q.query(
        `SELECT 1 FROM conversations c
           JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $2
          WHERE c.id = $1 FOR UPDATE OF c`,
        [input.conversationId, input.senderId],
      );
      if (!member.rows[0]) throw notFound("Conversation not found");

      const existing = await q.query("SELECT conversation_id, sender_id FROM messages WHERE id = $1", [input.id]);
      if (existing.rows[0]) {
        const e = existing.rows[0];
        if (e.conversation_id !== input.conversationId || e.sender_id !== input.senderId) {
          throw conflict("Message id is already in use");
        }
        return { message: (await getMessage(q, input.id))!, created: false };
      }

      if (input.replyToId) {
        const target = await q.query("SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2", [
          input.replyToId,
          input.conversationId,
        ]);
        if (!target.rows[0]) throw badRequest("The message you are replying to is not in this conversation");
      }

      let image: ImageDto | undefined;
      if (input.imageId) {
        const upload = await q.query<ImageDto>("SELECT url, width, height FROM uploads WHERE id = $1 AND user_id = $2", [input.imageId, input.senderId]);
        image = upload.rows[0];
        if (!image) throw badRequest("That image was not found. Upload it again.");
      }

      if (input.topicId) {
        const topic = await q.query("SELECT 1 FROM topics WHERE id = $1 AND conversation_id = $2", [input.topicId, input.conversationId]);
        if (!topic.rows[0]) throw badRequest("That topic is not in this conversation");
      }

      const { seq, rev } = await bump(q, input.conversationId, { newMessage: true });
      await q.query(
        `INSERT INTO messages (id, conversation_id, seq, rev, sender_id, text, image_url, image_width, image_height, reply_to_id, topic_id, topic_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          input.id, input.conversationId, seq, rev, input.senderId, input.text,
          image?.url ?? null, image?.width ?? null, image?.height ?? null, input.replyToId ?? null,
          input.topicId ?? null, input.topicId ? "lane" : null,
        ],
      );
      await saveMentions(q, input.id, input.conversationId, input.senderId, input.text);
      // Sending implies the sender has seen everything up to their own message.
      await q.query(
        "UPDATE conversation_members SET last_read_seq = $3 WHERE conversation_id = $1 AND user_id = $2",
        [input.conversationId, input.senderId, seq],
      );
      return { message: (await getMessage(q, input.id))!, created: true };
    });
  } catch (err) {
    // Only reachable if the id exists in a conversation this sender cannot see.
    if (isUniqueViolation(err, "messages_pkey")) throw conflict("Message id is already in use");
    throw err;
  }
}

export interface Page {
  messages: MessageDto[];
  /** Conversation rev at (or just before) the time of the read; the client's sync cursor. */
  rev: number;
  hasMore: boolean;
}

async function currentRev(q: Queryable, conversationId: string): Promise<number> {
  const { rows } = await q.query("SELECT rev FROM conversations WHERE id = $1", [conversationId]);
  if (!rows[0]) throw notFound("Conversation not found");
  return rows[0].rev;
}

/** One page of history, oldest first. `before` pages backwards, `after` forwards. */
export async function listMessages(
  q: Queryable,
  conversationId: string,
  opts: { before?: number; after?: number; limit: number; topicId?: string },
): Promise<Page> {
  // Read rev first: everything up to this rev is then guaranteed visible to the
  // query below, so a client that syncs from it later cannot miss a change.
  const rev = await currentRev(q, conversationId);
  const forward = opts.after !== undefined;
  const { rows } = await q.query(
    `SELECT ${MESSAGE_COLUMNS} FROM messages m
      WHERE m.conversation_id = $1
        AND ($2::bigint IS NULL OR m.seq < $2)
        AND ($3::bigint IS NULL OR m.seq > $3)
        AND ($5::uuid IS NULL OR m.topic_id = $5)
      ORDER BY m.seq ${forward ? "ASC" : "DESC"}
      LIMIT $4`,
    [conversationId, opts.before ?? null, opts.after ?? null, opts.limit + 1, opts.topicId ?? null],
  );
  const hasMore = rows.length > opts.limit;
  const page = rows.slice(0, opts.limit).map(toMessageDto);
  if (!forward) page.reverse();
  return { messages: page, rev, hasMore };
}

export interface Changes {
  /** Current state of every message created or changed since the given rev. */
  messages: MessageDto[];
  rev: number;
  /** True when too much changed to list; the client should reload its latest page. */
  reset: boolean;
}

export async function listChanges(q: Queryable, conversationId: string, since: number, limit: number): Promise<Changes> {
  const rev = await currentRev(q, conversationId);
  const { rows } = await q.query(
    `SELECT ${MESSAGE_COLUMNS} FROM messages m
      WHERE m.conversation_id = $1 AND m.rev > $2
      ORDER BY m.seq ASC LIMIT $3`,
    [conversationId, since, limit + 1],
  );
  if (rows.length > limit) return { messages: [], rev, reset: true };
  return { messages: rows.map(toMessageDto), rev, reset: false };
}

interface Target {
  conversationId: string;
  senderId: string | null;
  kind: "user" | "system";
  deleted: boolean;
  /** The caller's role in the message's conversation. */
  role: "admin" | "member";
  conversationType: "dm" | "group";
}

/**
 * Find a message for someone acting on it by id. Joins the caller's membership, so a
 * message in a conversation they are not in is indistinguishable from no message.
 */
export async function requireMessageAccess(q: Queryable, messageId: string, userId: string): Promise<Target> {
  const { rows } = await q.query(
    `SELECT m.conversation_id, m.sender_id, m.kind, m.deleted_at, cm.role, c.type
       FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1`,
    [messageId, userId],
  );
  const r = rows[0];
  if (!r) throw notFound("Message not found");
  return {
    conversationId: r.conversation_id,
    senderId: r.sender_id,
    kind: r.kind,
    deleted: r.deleted_at !== null,
    role: r.role,
    conversationType: r.type,
  };
}

/** Apply a change to one message and stamp it with the conversation's next rev. */
async function mutate(
  db: Db,
  messageId: string,
  userId: string,
  check: (target: Target) => void,
  change: (q: Queryable, target: Target) => Promise<boolean>,
): Promise<{ message: MessageDto; changed: boolean }> {
  return db.tx(async (q) => {
    const target = await requireMessageAccess(q, messageId, userId);
    check(target);
    // Lock the conversation so changes to it are applied one at a time, and only
    // spend a rev when something actually changed.
    await q.query("SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE", [target.conversationId]);
    const changed = await change(q, target);
    if (changed) {
      const { rev } = await bump(q, target.conversationId, { newMessage: false });
      await q.query("UPDATE messages SET rev = $2 WHERE id = $1", [messageId, rev]);
    }
    return { message: (await getMessage(q, messageId))!, changed };
  });
}

const mustBeLive = (t: Target) => {
  if (t.kind !== "user") throw forbidden("That message cannot be changed");
  if (t.deleted) throw conflict("That message was deleted");
};

export function editMessage(db: Db, messageId: string, userId: string, text: string) {
  return mutate(
    db,
    messageId,
    userId,
    (t) => {
      mustBeLive(t);
      if (t.senderId !== userId) throw forbidden("You can only edit your own messages");
    },
    async (q, t) => {
      const { rowCount } = await q.query(
        "UPDATE messages SET text = $2, edited_at = now() WHERE id = $1 AND text IS DISTINCT FROM $2",
        [messageId, text],
      );
      if (!rowCount) return false;
      await saveMentions(q, messageId, t.conversationId, userId, text);
      return true;
    },
  );
}

/** Delete for everyone. The content is erased, not just hidden; the row stays as a tombstone. */
export function deleteMessage(db: Db, messageId: string, userId: string) {
  return mutate(
    db,
    messageId,
    userId,
    (t) => {
      if (t.kind !== "user") throw forbidden("That message cannot be deleted");
      const isGroupAdmin = t.conversationType === "group" && t.role === "admin";
      if (t.senderId !== userId && !isGroupAdmin) throw forbidden("You can only delete your own messages");
    },
    async (q, t) => {
      if (t.deleted) return false;
      await q.query("UPDATE messages SET text = NULL, image_url = NULL, image_width = NULL, image_height = NULL, deleted_at = now() WHERE id = $1", [messageId]);
      await q.query("DELETE FROM reactions WHERE message_id = $1", [messageId]);
      // Nothing of a deleted message may remain findable, by keyword, meaning or mention.
      await q.query("DELETE FROM message_embeddings WHERE message_id = $1", [messageId]);
      await q.query("DELETE FROM message_mentions WHERE message_id = $1", [messageId]);
      return true;
    },
  );
}

export const MAX_REACTION_KINDS = 20;

export function setReaction(db: Db, messageId: string, userId: string, emoji: string, on: boolean) {
  return mutate(db, messageId, userId, mustBeLive, async (q) => {
    if (!on) {
      const { rowCount } = await q.query("DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3", [messageId, userId, emoji]);
      return (rowCount ?? 0) > 0;
    }
    const kinds = await q.query("SELECT DISTINCT emoji FROM reactions WHERE message_id = $1", [messageId]);
    if (kinds.rows.length >= MAX_REACTION_KINDS && !kinds.rows.some((r) => r.emoji === emoji)) {
      throw conflict("This message has too many different reactions");
    }
    const { rowCount } = await q.query(
      "INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [messageId, userId, emoji],
    );
    return (rowCount ?? 0) > 0;
  });
}
