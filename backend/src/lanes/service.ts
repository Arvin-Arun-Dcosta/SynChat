import type { Db, Queryable } from "../db.js";
import { CENTRE_PRIOR } from "../embedding/centre.js";
import { toSqlVector, type Embedder } from "../embedding/embedder.js";
import { EMBEDDING_DIM } from "../embedding/model.js";
import { badRequest, forbidden, notFound } from "../http/errors.js";
import type { KeyedQueue } from "../jobs/queue.js";
import { bump } from "../messages/service.js";
import type { Realtime } from "../realtime/realtime.js";
import type { TopicDto } from "../types.js";
import { assign, type HistoryMessage } from "./assigner.js";
import type { LaneParams } from "./params.js";
import { addresseesOf, analyseText, type Person } from "./text.js";
import { FALLBACK_TITLE, titleFromText } from "./title.js";

/** How many earlier messages the assigner is shown. The evaluation uses the same window. */
export const HISTORY = 200;

/** A change to a conversation's lanes, sent to every member as one `lanes:update` event. */
export interface LaneUpdate {
  conversationId: string;
  /** The conversation rev this change took, when it changed any message. */
  rev: number | null;
  /** Topics created or changed, in their current state. */
  topics: TopicDto[];
  /** Topics that no longer exist (emptied by a move, or merged away). */
  removed: string[];
  assignments: { messageId: string; topicId: string }[];
}

const TOPIC_SELECT = `
  SELECT t.id, t.conversation_id, t.title, t.title_source, t.created_at,
         -- Digest fields are only exposed while the group's AI switch is on.
         CASE WHEN c.ai_enabled THEN t.recap END AS recap,
         CASE WHEN c.ai_enabled THEN t.status END AS status,
         CASE WHEN c.ai_enabled THEN t.outcome END AS outcome,
         CASE WHEN c.ai_enabled THEN t.status_source END AS status_source,
         c.ai_enabled AND (t.digest_through_seq IS NULL OR t.digest_through_seq < s.last_seq) AS digest_stale,
         s.message_count, s.first_seq, s.last_seq, s.last_message_at,
         (SELECT json_build_object('senderId', m.sender_id, 'text', left(m.text, 120), 'hasImage', m.image_url IS NOT NULL)
            FROM messages m WHERE m.conversation_id = t.conversation_id AND m.topic_id = t.id AND m.deleted_at IS NULL
           ORDER BY m.seq DESC LIMIT 1) AS last_message,
         (SELECT coalesce(array_agg(x.sender_id), '{}')
            FROM (SELECT m.sender_id FROM messages m
                   WHERE m.conversation_id = t.conversation_id AND m.topic_id = t.id AND m.deleted_at IS NULL AND m.sender_id IS NOT NULL
                   GROUP BY m.sender_id ORDER BY max(m.seq) DESC LIMIT 6) x) AS participants,
         (SELECT count(*) FROM messages m
           WHERE m.conversation_id = t.conversation_id AND m.topic_id = t.id AND m.deleted_at IS NULL
             AND m.seq > $2::bigint AND m.sender_id IS DISTINCT FROM $3::uuid) AS unread_count,
         EXISTS (SELECT 1 FROM topic_mutes tm WHERE tm.topic_id = t.id AND tm.user_id = $3::uuid) AS muted
    FROM topics t
    JOIN conversations c ON c.id = t.conversation_id
    JOIN LATERAL (
      SELECT count(*) AS message_count, min(m.seq) AS first_seq, max(m.seq) AS last_seq, max(m.created_at) AS last_message_at
        FROM messages m
       WHERE m.conversation_id = t.conversation_id AND m.topic_id = t.id AND m.deleted_at IS NULL
    ) s ON s.message_count > 0
   WHERE t.conversation_id = $1`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTopicDto(r: any): TopicDto {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    title: r.title,
    titleSource: r.title_source,
    createdAt: r.created_at,
    messageCount: r.message_count,
    firstSeq: r.first_seq,
    lastSeq: r.last_seq,
    lastMessageAt: r.last_message_at,
    lastMessage: r.last_message,
    participants: r.participants,
    unreadCount: r.unread_count,
    muted: r.muted,
    recap: r.recap,
    status: r.status,
    outcome: r.outcome,
    statusSource: r.status_source,
    digestStale: r.digest_stale,
  };
}

/**
 * Topics of a conversation that have at least one live message, most recently active
 * first. Pass `viewer` to get that member's unread counts; without it they are 0.
 */
export async function listTopics(
  q: Queryable,
  conversationId: string,
  opts: { viewer?: { userId: string; lastReadSeq: number }; only?: string[] } = {},
): Promise<TopicDto[]> {
  const { rows } = await q.query(`${TOPIC_SELECT} AND ($4::uuid[] IS NULL OR t.id = ANY($4)) ORDER BY s.last_seq DESC`, [
    conversationId,
    opts.viewer?.lastReadSeq ?? Number.MAX_SAFE_INTEGER,
    opts.viewer?.userId ?? null,
    opts.only ?? null,
  ]);
  return rows.map(toTopicDto);
}

/**
 * The conversation's recent messages that have a topic, newest first, each with its
 * similarity to `vector` (null when either side has no embedding).
 *
 * Similarity is centred (embedding/centre.ts): the mean of the window's vectors,
 * shrunk toward zero while the conversation is young, is subtracted from both sides
 * first. pgvector does all of it, so no vectors are shipped back to Node. The offline
 * evaluation computes the same quantity in TypeScript; a test checks the two agree.
 */
export async function recentWithSimilarity(
  q: Queryable,
  conversationId: string,
  beforeSeq: number,
  vector: Float32Array | null,
): Promise<{ sender_id: string | null; created_at: Date; topic_id: string; text: string | null; sim: number | null }[]> {
  const { rows } = await q.query(
    `WITH recent AS (
       SELECT m.seq, m.sender_id, m.created_at, m.topic_id, m.text, e.embedding
         FROM messages m LEFT JOIN message_embeddings e ON e.message_id = m.id
        WHERE m.conversation_id = $1 AND m.seq < $2 AND m.kind = 'user' AND m.deleted_at IS NULL AND m.topic_id IS NOT NULL
        ORDER BY m.seq DESC LIMIT ${HISTORY}
     ), centre AS (
       -- The shrunk mean: averaging in CENTRE_PRIOR zero vectors divides the sum by n + prior.
       SELECT avg(v) AS mean FROM (
         SELECT embedding AS v FROM recent WHERE embedding IS NOT NULL
         UNION ALL
         SELECT array_fill(0::real, ARRAY[${EMBEDDING_DIM}])::vector FROM generate_series(1, ${CENTRE_PRIOR})
       ) vectors
     )
     SELECT r.sender_id, r.created_at, r.topic_id, r.text,
            CASE WHEN $3::vector IS NULL OR r.embedding IS NULL THEN NULL
                 ELSE 1 - ((r.embedding - c.mean) <=> ($3::vector - c.mean)) END AS sim
       FROM recent r CROSS JOIN centre c
      ORDER BY r.seq DESC`,
    [conversationId, beforeSeq, vector ? toSqlVector(vector) : null],
  );
  return rows.map((r) => ({ ...r, sim: r.sim === null ? null : Number(r.sim) })) as never;
}

async function people(q: Queryable, conversationId: string): Promise<Person[]> {
  const { rows } = await q.query(
    `SELECT u.id, u.username, u.full_name FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = $1`,
    [conversationId],
  );
  return rows.map((r) => ({ id: r.id, names: [...new Set([String(r.username).toLowerCase(), String(r.full_name).toLowerCase().split(/\s+/)[0]!])] }));
}

/** A topic the caller may act on: it must be in a conversation they belong to. */
export async function requireTopicAccess(q: Queryable, topicId: string, userId: string): Promise<{ conversationId: string; title: string }> {
  const { rows } = await q.query(
    `SELECT t.conversation_id, t.title FROM topics t
       JOIN conversation_members cm ON cm.conversation_id = t.conversation_id AND cm.user_id = $2
      WHERE t.id = $1`,
    [topicId, userId],
  );
  if (!rows[0]) throw notFound("Topic not found");
  return { conversationId: rows[0].conversation_id, title: rows[0].title };
}

/** Delete topics that no longer have any live message. Returns the ids removed. */
export async function dropEmptyTopics(q: Queryable, conversationId: string, candidates: string[]): Promise<string[]> {
  if (candidates.length === 0) return [];
  const { rows } = await q.query(
    `DELETE FROM topics t
      WHERE t.conversation_id = $1 AND t.id = ANY($2)
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.topic_id = t.id AND m.deleted_at IS NULL)
      RETURNING t.id`,
    [conversationId, candidates],
  );
  return rows.map((r) => r.id as string);
}

export class LaneService {
  private warnedNoModel = false;

  constructor(
    private readonly db: Db,
    private readonly rt: Realtime,
    private readonly queue: KeyedQueue,
    private readonly embedder: Embedder | null,
    private readonly params: LaneParams,
  ) {}

  /** Called whenever a message lands in a topic. The digest service listens, when there is one. */
  onTopicActivity: (conversationId: string, topicId: string) => void = () => {};

  /** Called once a new message's topic is settled (or at once in a DM). Push notifications hang off this. */
  onMessageReady: (messageId: string) => void = () => {};
  private readonly announced = new Set<string>();
  private ready(messageId: string): void {
    // Each message is announced once, even if its job runs again after a restart.
    if (this.announced.has(messageId)) return;
    this.announced.add(messageId);
    if (this.announced.size > 5000) this.announced.delete(this.announced.values().next().value!);
    this.onMessageReady(messageId);
  }

  /** Call after a message is stored. Returns at once; the work happens on the queue. */
  messageCreated(conversationId: string, messageId: string): void {
    // Keyed by conversation: its messages are embedded and assigned strictly in order.
    this.queue.enqueue(conversationId, () => this.process(messageId));
  }

  /** Call after a message's text changed: its embedding is stale. Its topic is kept. */
  messageEdited(conversationId: string, messageId: string): void {
    this.queue.enqueue(conversationId, async () => {
      await this.db.query("DELETE FROM message_embeddings WHERE message_id = $1", [messageId]);
      await this.embedMessage(messageId);
    });
  }

  idle(): Promise<void> {
    return this.queue.idle();
  }

  /**
   * Load the embedding model now rather than on the first message, which would
   * otherwise wait several seconds (or, on the very first run, for the download).
   */
  async warmUp(): Promise<boolean> {
    if (!this.embedder) return false;
    try {
      await this.embedder.embed(["warm up"]);
      return true;
    } catch (err) {
      console.error("[lanes] embedding model failed to load; lanes will use conversational signals only:", (err as Error).message);
      this.warnedNoModel = true;
      return false;
    }
  }

  /**
   * The queue lives in memory, so work that was pending when the process stopped is
   * gone. Find recent messages that still lack a topic or an embedding and queue them
   * again. Processing a message twice is harmless.
   */
  async recover(): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT m.id, m.conversation_id
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN message_embeddings e ON e.message_id = m.id
        WHERE m.kind = 'user' AND m.deleted_at IS NULL AND m.created_at > now() - interval '7 days'
          AND ((c.type = 'group' AND m.topic_id IS NULL) OR (m.text IS NOT NULL AND e.message_id IS NULL))
        ORDER BY m.conversation_id, m.seq
        LIMIT 5000`,
    );
    for (const r of rows) this.messageCreated(r.conversation_id, r.id);
    return rows.length;
  }

  /** Store an embedding for a message if it has text and none yet. Returns the vector. */
  private async embedMessage(messageId: string): Promise<Float32Array | null> {
    const { rows } = await this.db.query(
      `SELECT m.conversation_id, m.text, e.embedding::text AS embedding
         FROM messages m LEFT JOIN message_embeddings e ON e.message_id = m.id
        WHERE m.id = $1 AND m.deleted_at IS NULL`,
      [messageId],
    );
    const row = rows[0];
    if (!row || !row.text?.trim()) return null;
    if (row.embedding) return Float32Array.from(JSON.parse(row.embedding) as number[]);
    if (!this.embedder) return null;
    try {
      const [vector] = await this.embedder.embed([row.text]);
      if (!vector) return null;
      await this.db.query(
        `INSERT INTO message_embeddings (message_id, conversation_id, embedding, model)
         SELECT m.id, m.conversation_id, $2::vector, $3 FROM messages m WHERE m.id = $1 AND m.deleted_at IS NULL
         ON CONFLICT (message_id) DO NOTHING`,
        [messageId, toSqlVector(vector), this.embedder.model],
      );
      return vector;
    } catch (err) {
      // Without the model, lanes still work from the conversational signals alone.
      if (!this.warnedNoModel) console.error("[lanes] embedding unavailable, assigning without it:", (err as Error).message);
      this.warnedNoModel = true;
      return null;
    }
  }

  /** Embed one message and, in a group, decide its topic. */
  private async process(messageId: string): Promise<void> {
    const vector = await this.embedMessage(messageId); // slow part, done before taking any lock
    const update = await this.db.tx((q) => this.assignInTx(q, messageId, vector));
    this.ready(messageId);
    if (!update) return;
    await this.rt.toConversation(update.conversationId, "lanes:update", update);
    for (const t of update.topics) this.onTopicActivity(update.conversationId, t.id);
  }

  private async assignInTx(q: Queryable, messageId: string, vector: Float32Array | null): Promise<LaneUpdate | null> {
    // Lock the conversation: assignment, moves and merges are applied one at a time.
    const found = await q.query(
      `SELECT m.conversation_id, m.seq, m.sender_id, m.text, m.created_at, m.topic_id, m.reply_to_id, c.type
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = $1 AND m.kind = 'user' AND m.deleted_at IS NULL
        FOR UPDATE OF c`,
      [messageId],
    );
    const m = found.rows[0];
    if (!m || m.type !== "group") return null;
    const conversationId: string = m.conversation_id;

    // Sent from inside a lane: the topic was fixed at send time. Tell everyone the lane grew.
    if (m.topic_id) {
      return { conversationId, rev: null, topics: await listTopics(q, conversationId, { only: [m.topic_id] }), removed: [], assignments: [] };
    }

    let topicId: string | null = null;
    let source: "auto" | "reply" = "auto";
    let score: number | null = null;

    // An explicit reply settles it: the message joins the topic of what it replies to.
    if (m.reply_to_id) {
      const parent = await q.query("SELECT topic_id FROM messages WHERE id = $1 AND conversation_id = $2", [m.reply_to_id, conversationId]);
      if (parent.rows[0]?.topic_id) {
        topicId = parent.rows[0].topic_id;
        source = "reply";
      }
    }

    if (!topicId) {
      const who = await people(q, conversationId);
      const rows = await recentWithSimilarity(q, conversationId, m.seq, vector);
      const history: HistoryMessage[] = rows.reverse().map((h) => ({
        senderId: h.sender_id ?? "",
        at: new Date(h.created_at).getTime(),
        topicId: h.topic_id,
        sim: h.sim,
        text: analyseText(h.text),
        addressees: addresseesOf(h.text, h.sender_id ?? "", who),
      }));
      const decision = assign(
        {
          senderId: m.sender_id ?? "",
          at: new Date(m.created_at).getTime(),
          text: analyseText(m.text),
          addressees: addresseesOf(m.text, m.sender_id ?? "", who),
          hasEmbedding: vector !== null,
        },
        history,
        this.params,
      );
      topicId = decision.topicId;
      score = decision.topicId ? decision.score - decision.newScore : null;
    }

    if (!topicId) {
      const created = await q.query("INSERT INTO topics (conversation_id, title) VALUES ($1, $2) RETURNING id", [
        conversationId,
        titleFromText(m.text) ?? FALLBACK_TITLE,
      ]);
      topicId = created.rows[0]!.id as string;
    } else {
      // A topic that opened with "hey guys" is still untitled: name it after the first
      // message that says what it is about.
      const better = titleFromText(m.text);
      if (better) {
        await q.query("UPDATE topics SET title = $2 WHERE id = $1 AND title_source = 'auto' AND title = $3", [topicId, better, FALLBACK_TITLE]);
      }
    }

    const { rev } = await bump(q, conversationId, { newMessage: false });
    await q.query("UPDATE messages SET topic_id = $2, topic_source = $3, topic_score = $4, rev = $5 WHERE id = $1", [messageId, topicId, source, score, rev]);
    return { conversationId, rev, topics: await listTopics(q, conversationId, { only: [topicId] }), removed: [], assignments: [{ messageId, topicId }] };
  }

  // --- Corrections. Each applies for everyone and is recorded as labelled data. ---

  /** Move one message to another topic, or to a new one. */
  async moveMessage(messageId: string, userId: string, target: { topicId: string } | { title?: string }): Promise<LaneUpdate> {
    const update = await this.db.tx(async (q) => {
      const found = await q.query(
        `SELECT m.conversation_id, m.text, m.kind, m.deleted_at, m.topic_id, m.topic_source, m.topic_score, c.type
           FROM messages m
           JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
           JOIN conversations c ON c.id = m.conversation_id
          WHERE m.id = $1 FOR UPDATE OF c`,
        [messageId, userId],
      );
      const m = found.rows[0];
      if (!m) throw notFound("Message not found");
      if (m.type !== "group") throw badRequest("Topics only exist in groups");
      if (m.kind !== "user" || m.deleted_at) throw forbidden("That message cannot be moved");
      const conversationId: string = m.conversation_id;

      let toTopicId: string;
      if ("topicId" in target) {
        const ok = await q.query("SELECT 1 FROM topics WHERE id = $1 AND conversation_id = $2", [target.topicId, conversationId]);
        if (!ok.rows[0]) throw badRequest("That topic is not in this conversation");
        toTopicId = target.topicId;
      } else {
        const title = target.title?.trim();
        const created = await q.query("INSERT INTO topics (conversation_id, title, title_source) VALUES ($1, $2, $3) RETURNING id", [
          conversationId,
          title || titleFromText(m.text) || FALLBACK_TITLE,
          title ? "user" : "auto",
        ]);
        toTopicId = created.rows[0]!.id;
      }
      if (toTopicId === m.topic_id) {
        return { conversationId, rev: null, topics: [], removed: [], assignments: [] } satisfies LaneUpdate;
      }

      const { rev } = await bump(q, conversationId, { newMessage: false });
      await q.query("UPDATE messages SET topic_id = $2, topic_source = 'user', topic_score = NULL, rev = $3 WHERE id = $1", [messageId, toTopicId, rev]);
      await q.query(
        `INSERT INTO topic_corrections (conversation_id, user_id, kind, message_id, from_topic_id, to_topic_id, details)
         VALUES ($1, $2, 'move', $3, $4, $5, $6)`,
        [conversationId, userId, messageId, m.topic_id, toTopicId, JSON.stringify({ previousSource: m.topic_source, previousScore: m.topic_score, newTopic: !("topicId" in target) })],
      );
      const removed = await dropEmptyTopics(q, conversationId, m.topic_id ? [m.topic_id] : []);
      const changed = [toTopicId, ...(m.topic_id && !removed.includes(m.topic_id) ? [m.topic_id] : [])];
      return { conversationId, rev, topics: await listTopics(q, conversationId, { only: changed }), removed, assignments: [{ messageId, topicId: toTopicId }] } satisfies LaneUpdate;
    });
    if (update.rev !== null) await this.rt.toConversation(update.conversationId, "lanes:update", update);
    return update;
  }

  /** Fold one topic into another: all of its messages move, and it disappears. */
  async mergeTopics(fromTopicId: string, intoTopicId: string, userId: string): Promise<LaneUpdate> {
    if (fromTopicId === intoTopicId) throw badRequest("Pick a different topic to merge into");
    const update = await this.db.tx(async (q) => {
      const from = await requireTopicAccess(q, fromTopicId, userId);
      const conversationId = from.conversationId;
      await q.query("SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
      const into = await q.query("SELECT title FROM topics WHERE id = $1 AND conversation_id = $2", [intoTopicId, conversationId]);
      if (!into.rows[0]) throw badRequest("That topic is not in this conversation");

      // One rev for the whole merge: every moved message is stamped with it.
      const { rev } = await bump(q, conversationId, { newMessage: false });
      const moved = await q.query("UPDATE messages SET topic_id = $2, rev = $3 WHERE conversation_id = $4 AND topic_id = $1 RETURNING id", [
        fromTopicId,
        intoTopicId,
        rev,
        conversationId,
      ]);
      await q.query(
        `INSERT INTO topic_corrections (conversation_id, user_id, kind, from_topic_id, to_topic_id, details)
         VALUES ($1, $2, 'merge', $3, $4, $5)`,
        [conversationId, userId, fromTopicId, intoTopicId, JSON.stringify({ fromTitle: from.title, intoTitle: into.rows[0].title, messages: moved.rows.length })],
      );
      // Questions found in the old topic follow its messages; the merged topic needs a new digest.
      await q.query("UPDATE topic_questions SET topic_id = $2 WHERE topic_id = $1", [fromTopicId, intoTopicId]);
      await q.query("UPDATE topics SET digest_through_seq = NULL WHERE id = $1", [intoTopicId]);
      await q.query("DELETE FROM topics WHERE id = $1", [fromTopicId]);
      return {
        conversationId,
        rev,
        topics: await listTopics(q, conversationId, { only: [intoTopicId] }),
        removed: [fromTopicId],
        assignments: moved.rows.map((r) => ({ messageId: r.id as string, topicId: intoTopicId })),
      } satisfies LaneUpdate;
    });
    await this.rt.toConversation(update.conversationId, "lanes:update", update);
    return update;
  }

  async renameTopic(topicId: string, userId: string, title: string): Promise<LaneUpdate> {
    const update = await this.db.tx(async (q) => {
      const topic = await requireTopicAccess(q, topicId, userId);
      await q.query("UPDATE topics SET title = $2, title_source = 'user' WHERE id = $1", [topicId, title]);
      await q.query(
        `INSERT INTO topic_corrections (conversation_id, user_id, kind, to_topic_id, details) VALUES ($1, $2, 'rename', $3, $4)`,
        [topic.conversationId, userId, topicId, JSON.stringify({ from: topic.title, to: title })],
      );
      return { conversationId: topic.conversationId, rev: null, topics: await listTopics(q, topic.conversationId, { only: [topicId] }), removed: [], assignments: [] } satisfies LaneUpdate;
    });
    await this.rt.toConversation(update.conversationId, "lanes:update", update);
    return update;
  }
}
