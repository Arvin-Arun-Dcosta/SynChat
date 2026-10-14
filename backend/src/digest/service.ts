import { requireAdmin, systemLine } from "../conversations/service.js";
import type { Db } from "../db.js";
import { badRequest, forbidden, notFound } from "../http/errors.js";
import type { KeyedQueue } from "../jobs/queue.js";
import { dropEmptyTopics, listTopics, requireTopicAccess, type LaneUpdate } from "../lanes/service.js";
import { FALLBACK_TITLE } from "../lanes/title.js";
import { bump } from "../messages/service.js";
import { MESSAGE_COLUMNS, toMessageDto } from "../messages/service.js";
import type { Realtime } from "../realtime/realtime.js";
import type { InboxItemDto } from "../types.js";
import type { DigestInput, DigestModel, DigestOutput } from "./model.js";
import { planTidy, TIDY_WINDOW, tidyRequest, type TidyPlan, type TidyRow } from "./tidy.js";

/** How much of a topic the model is shown. Bounds the cost of one digest. */
const MAX_MESSAGES = 80;
/** Lanes with nothing in the tidy window that the model is still told about, so a quiet topic can be picked up again. */
const MAX_OTHER_LANES = 12;

export interface DigestTiming {
  /** The AI pass runs once a conversation has been quiet this long... */
  quietMs: number;
  /** ...or, in a group that never goes quiet, this long after the first unprocessed message. */
  maxWaitMs: number;
  /** However often members ask, a topic is not digested again sooner than this. */
  minIntervalMs: number;
}
const MAX_MESSAGE_CHARS = 500;

/**
 * Model output is untrusted: it was written by a model that read user messages.
 * Keep it to a bounded, single-purpose piece of plain text before storing it.
 * (The client then renders it as text, never as markup.)
 */
export function cleanText(value: unknown, max: number, maxLines = 1): string {
  if (typeof value !== "string") return "";
  const lines = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, maxLines);
  const text = lines.join(maxLines > 1 ? "\n" : " ");
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

interface Prepared {
  input: DigestInput;
  throughSeq: number;
  messageByRef: Map<string, { id: string; senderId: string | null }>;
  userByRef: Map<string, string>;
}

/**
 * The LLM-backed work, for groups whose admin has turned AI features on. Two jobs,
 * both run when a conversation has gone quiet (or when a member asks), never once
 * per message:
 *
 *   tidy    re-sort the recent messages into lanes, correcting the instant first
 *           pass of the local assigner
 *   digest  a structured summary of each topic that changed; catch-up,
 *           decided-or-open and the questions inbox are read from what it stores
 */
export class DigestService {
  /** Per conversation: the quiet timer, when the wait began, and the topics touched since. */
  private readonly pending = new Map<string, { timer: NodeJS.Timeout; since: number; topics: Set<string> }>();
  private readonly lastRun = new Map<string, number>();
  private readonly running = new Map<string, Promise<boolean>>();

  constructor(
    private readonly db: Db,
    private readonly rt: Realtime,
    private readonly queue: KeyedQueue,
    private readonly model: DigestModel,
    private readonly timing: DigestTiming,
  ) {}

  /** A message was placed in this topic. Do the AI pass once the conversation has been quiet for a while. */
  topicActive(conversationId: string, topicId: string): void {
    const now = Date.now();
    const p = this.pending.get(conversationId);
    if (p) clearTimeout(p.timer);
    const since = p?.since ?? now;
    const topics = p?.topics ?? new Set<string>();
    topics.add(topicId);
    // A busy group may never be quiet for long: after maxWait, stop waiting.
    const wait = Math.max(0, Math.min(this.timing.quietMs, since + this.timing.maxWaitMs - now));
    const timer = setTimeout(() => {
      this.pending.delete(conversationId);
      this.queue.enqueue(`digest:${conversationId}`, () => this.pass(conversationId, [...topics]));
    }, wait);
    timer.unref();
    this.pending.set(conversationId, { timer, since, topics });
  }

  /** Tidy the lanes first, then digest every topic that was touched or changed. */
  private async pass(conversationId: string, touched: string[]): Promise<void> {
    const changed = await this.tidy(conversationId).catch((err) => {
      console.error(`[tidy] conversation ${conversationId}: ${(err as Error).message}`);
      return [] as string[];
    });
    for (const topicId of new Set([...touched, ...changed])) await this.run(topicId);
  }

  idle(): Promise<void> {
    return this.queue.idle();
  }

  close(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  /** A member asks for an up-to-date digest of a topic (e.g. opening catch-up). */
  async refresh(topicId: string, userId: string): Promise<LaneUpdate> {
    const { conversationId } = await requireTopicAccess(this.db, topicId, userId);
    await this.requireEnabled(conversationId);
    // Here a failure is not swallowed: the member asked, so they are told (as a 502).
    if (Date.now() - (this.lastRun.get(topicId) ?? 0) >= this.timing.minIntervalMs) await this.attempt(topicId);
    return { conversationId, rev: null, topics: await listTopics(this.db, conversationId, { only: [topicId] }), removed: [], assignments: [] };
  }

  private async requireEnabled(conversationId: string): Promise<void> {
    const { rows } = await this.db.query("SELECT ai_enabled FROM conversations WHERE id = $1", [conversationId]);
    if (!rows[0]?.ai_enabled) throw forbidden("AI features are not turned on for this group");
  }

  /** Digest a topic if it has changed since its last digest. Concurrent calls share one attempt. */
  private attempt(topicId: string): Promise<boolean> {
    const existing = this.running.get(topicId);
    if (existing) return existing;
    const work = this.runOnce(topicId).finally(() => this.running.delete(topicId));
    this.running.set(topicId, work);
    return work;
  }

  /** The background form: a failure is logged and the previous digest stays in place. */
  run(topicId: string): Promise<boolean> {
    return this.attempt(topicId).catch((err) => {
      console.error(`[digest] topic ${topicId}: ${(err as Error).message}`);
      return false;
    });
  }

  private async prepare(topicId: string): Promise<(Prepared & { conversationId: string }) | null> {
    const topic = await this.db.query(
      `SELECT t.conversation_id, t.digest_through_seq, c.ai_enabled, c.type
         FROM topics t JOIN conversations c ON c.id = t.conversation_id WHERE t.id = $1`,
      [topicId],
    );
    const t = topic.rows[0];
    if (!t || !t.ai_enabled || t.type !== "group") return null;

    const { rows } = await this.db.query(
      `SELECT m.id, m.seq, m.sender_id, m.text, m.image_url IS NOT NULL AS has_image, m.created_at
         FROM messages m
        WHERE m.conversation_id = $1 AND m.topic_id = $2 AND m.kind = 'user' AND m.deleted_at IS NULL
        ORDER BY m.seq DESC LIMIT ${MAX_MESSAGES}`,
      [t.conversation_id, topicId],
    );
    if (rows.length === 0) return null;
    const throughSeq = rows[0]!.seq as number;
    if (t.digest_through_seq !== null && t.digest_through_seq >= throughSeq) return null; // nothing new
    rows.reverse();

    const members = await this.db.query(
      `SELECT u.id, u.full_name FROM conversation_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = $1 ORDER BY cm.joined_at, u.id`,
      [t.conversation_id],
    );
    // The model sees "P1 = Asha", never an id, username or email.
    const refOfUser = new Map<string, string>();
    const userByRef = new Map<string, string>();
    const people = members.rows.map((m, i) => {
      const ref = `P${i + 1}`;
      refOfUser.set(m.id, ref);
      userByRef.set(ref, m.id);
      return { ref, name: cleanText(String(m.full_name).split(/\s+/)[0], 40) || "Someone" };
    });

    const newest = new Date(rows[rows.length - 1]!.created_at).getTime();
    const messageByRef = new Map<string, { id: string; senderId: string | null }>();
    const messages = rows.map((m, i) => {
      const ref = `m${i + 1}`;
      messageByRef.set(ref, { id: m.id, senderId: m.sender_id });
      const text = (m.text as string | null)?.slice(0, MAX_MESSAGE_CHARS) ?? "";
      return {
        ref,
        author: refOfUser.get(m.sender_id) ?? "someone who has left",
        text: text || (m.has_image ? "[photo]" : ""),
        minutesAgo: Math.round((newest - new Date(m.created_at).getTime()) / 60_000),
      };
    });
    return { conversationId: t.conversation_id, input: { people, messages }, throughSeq, messageByRef, userByRef };
  }

  private async runOnce(topicId: string): Promise<boolean> {
    const prepared = await this.prepare(topicId);
    if (!prepared) return false;
    this.lastRun.set(topicId, Date.now());
    const output = await this.model.digest(prepared.input); // the only call that leaves the server
    const askedOf = await this.store(topicId, prepared, output);
    if (askedOf === null) return false;
    const { conversationId } = prepared;
    const update: LaneUpdate = { conversationId, rev: null, topics: await listTopics(this.db, conversationId, { only: [topicId] }), removed: [], assignments: [] };
    await this.rt.toConversation(conversationId, "lanes:update", update);
    this.rt.toUsers(askedOf, "inbox:update", {});
    return true;
  }

  /** Validate the model's output against what we actually sent, and save it. */
  private async store(topicId: string, p: Prepared & { conversationId: string }, out: DigestOutput): Promise<string[] | null> {
    const title = cleanText(out.title, 60);
    const recap = cleanText(out.recap, 280, 2);
    const status = out.status === "decided" ? "decided" : "open";
    const outcome = status === "decided" ? cleanText(out.outcome, 200) || null : null;

    // A question only counts if it points at a message we sent and at a current member
    // other than its author. Anything else the model made up, or was talked into.
    const questions = new Map<string, { messageId: string; askedOf: string; question: string; answered: boolean }>();
    for (const q of Array.isArray(out.questions) ? out.questions.slice(0, 40) : []) {
      const message = p.messageByRef.get(String(q?.message));
      const text = cleanText(q?.question, 160);
      if (!message || !text || !Array.isArray(q.asked_of)) continue;
      for (const ref of q.asked_of.slice(0, 10)) {
        const userId = p.userByRef.get(String(ref));
        if (!userId || userId === message.senderId) continue;
        questions.set(`${message.id}:${userId}`, { messageId: message.id, askedOf: userId, question: text, answered: q.answered === true });
      }
    }

    return this.db.tx(async (q) => {
      // The admin may have switched AI off while the model was working: then drop the result.
      const live = await q.query(
        `SELECT 1 FROM topics t JOIN conversations c ON c.id = t.conversation_id AND c.ai_enabled WHERE t.id = $1 FOR UPDATE OF t`,
        [topicId],
      );
      if (!live.rows[0]) return null;
      await q.query(
        `UPDATE topics SET
           recap = $2, digest_through_seq = $3, digest_at = now(), digest_model = $4,
           -- A status a member set by hand is never overwritten.
           status        = CASE WHEN status_source = 'user' THEN status  ELSE $5 END,
           outcome       = CASE WHEN status_source = 'user' THEN outcome ELSE $6 END,
           status_source = CASE WHEN status_source = 'user' THEN 'user'  ELSE 'llm' END,
           -- Nor is a title a member chose.
           title         = CASE WHEN title_source <> 'user' AND $7 <> '' THEN $7 ELSE title END,
           title_source  = CASE WHEN title_source <> 'user' AND $7 <> '' THEN 'llm' ELSE title_source END
         WHERE id = $1`,
        [topicId, recap || null, p.throughSeq, this.model.name, status, outcome, title],
      );
      for (const item of questions.values()) {
        await q.query(
          `INSERT INTO topic_questions (conversation_id, topic_id, message_id, asked_of, question, answered)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (message_id, asked_of) DO UPDATE SET question = EXCLUDED.question, answered = EXCLUDED.answered, topic_id = EXCLUDED.topic_id`,
          [p.conversationId, topicId, item.messageId, item.askedOf, item.question, item.answered],
        );
      }
      return [...new Set([...questions.values()].map((x) => x.askedOf))];
    });
  }

  // --- Lane tidy-up ---------------------------------------------------------

  /**
   * Re-sort the conversation's recent messages into lanes with the model, and apply
   * what it changes. Returns the ids of the topics affected. Does nothing when no
   * message has arrived since the last tidy-up, or when AI is off for the group.
   *
   * What the model may not do (enforced in planTidy and again in the UPDATE): move a
   * message a person placed, separate an explicit reply from the message it replies
   * to, or touch anything outside the window it was shown.
   */
  async tidy(conversationId: string): Promise<string[]> {
    const c = await this.db.query("SELECT type, ai_enabled, tidy_through_seq FROM conversations WHERE id = $1", [conversationId]);
    if (!c.rows[0]?.ai_enabled || c.rows[0].type !== "group") return [];
    const through: number = c.rows[0].tidy_through_seq === null ? 0 : Number(c.rows[0].tidy_through_seq);
    const { rows: recent } = await this.db.query(
      `SELECT m.id, m.seq, m.sender_id, m.text, m.image_url IS NOT NULL AS has_image, m.created_at,
              m.topic_id, m.topic_source, m.reply_to_id
         FROM messages m
        WHERE m.conversation_id = $1 AND m.kind = 'user' AND m.deleted_at IS NULL AND m.topic_id IS NOT NULL
        ORDER BY m.seq DESC LIMIT ${TIDY_WINDOW}`,
      [conversationId],
    );
    if (recent.length < 2) return [];
    const throughSeq = Number(recent[0]!.seq);
    if (throughSeq <= through) return [];
    recent.reverse();

    const members = await this.db.query(
      `SELECT u.id, u.full_name FROM conversation_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = $1 ORDER BY cm.joined_at, u.id`,
      [conversationId],
    );
    const personRef = new Map<string, string>();
    const people = members.rows.map((m, i) => {
      personRef.set(m.id, `P${i + 1}`);
      return { ref: `P${i + 1}`, name: cleanText(String(m.full_name).split(/\s+/)[0], 40) || "Someone" };
    });

    // Established lanes: an earlier tidy-up or a person has confirmed something in them.
    // The window's own come first, then the most recently active of the rest.
    const lanes = await this.db.query(
      `SELECT t.id, t.title, max(m.seq) AS last_seq
         FROM topics t JOIN messages m ON m.topic_id = t.id AND m.deleted_at IS NULL
        WHERE t.conversation_id = $1
        GROUP BY t.id
       HAVING bool_or(m.seq <= $2 OR m.topic_source IN ('user', 'lane', 'llm'))
        ORDER BY last_seq DESC`,
      [conversationId, through],
    );
    const inWindow = new Set(recent.map((r) => r.topic_id as string));
    const established = [...lanes.rows.filter((l) => inWindow.has(l.id)), ...lanes.rows.filter((l) => !inWindow.has(l.id)).slice(0, MAX_OTHER_LANES)].map((l) => ({
      id: l.id as string,
      title: l.title as string,
    }));

    const ids = new Set(recent.map((r) => r.id as string));
    const rows: TidyRow[] = recent.map((r) => {
      const parentInWindow = r.topic_source === "reply" && r.reply_to_id && ids.has(r.reply_to_id);
      return {
        id: r.id,
        topicId: r.topic_id,
        author: personRef.get(r.sender_id) ?? "someone who has left",
        text: (r.text as string | null)?.slice(0, MAX_MESSAGE_CHARS) || (r.has_image ? "[photo]" : ""),
        at: new Date(r.created_at).getTime(),
        // A reply whose parent is out of sight has nothing to follow, so it stays.
        locked: r.topic_source === "user" || r.topic_source === "lane" || (r.topic_source === "reply" && !parentInWindow),
        parentId: parentInWindow ? r.reply_to_id : null,
        sorted: Number(r.seq) <= through || r.topic_source === "llm",
      };
    });

    const request = tidyRequest(rows, people, established);
    const output = await this.model.tidy(request.input); // leaves the server
    const update = await this.applyTidy(conversationId, rows, planTidy(rows, request.laneRef, output), throughSeq);
    if (update && update.rev !== null) await this.rt.toConversation(conversationId, "lanes:update", update);
    return update ? update.topics.map((t) => t.id) : [];
  }

  private async applyTidy(conversationId: string, rows: TidyRow[], plan: TidyPlan, throughSeq: number): Promise<LaneUpdate | null> {
    return this.db.tx(async (q) => {
      const live = await q.query("SELECT ai_enabled FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
      if (!live.rows[0]?.ai_enabled) return null; // switched off while the model was working
      await q.query("UPDATE conversations SET tidy_through_seq = GREATEST(coalesce(tidy_through_seq, 0), $2) WHERE id = $1", [conversationId, throughSeq]);
      const nothing = { conversationId, rev: null, topics: [], removed: [], assignments: [] } satisfies LaneUpdate;
      if (plan.moves.size === 0 && plan.retitle.size === 0) return nothing;

      const { rev } = await bump(q, conversationId, { newMessage: false });
      const affected = new Set<string>();
      // The model's name for a lane the local assigner opened, unless a person has named it.
      for (const [topicId, title] of plan.retitle) {
        const clean = cleanText(title, 60);
        if (!clean) continue;
        const renamed = await q.query(
          "UPDATE topics SET title = $3, title_source = 'llm' WHERE id = $1 AND conversation_id = $2 AND title_source = 'auto' AND title <> $3",
          [topicId, conversationId, clean],
        );
        if (renamed.rowCount) affected.add(topicId);
      }
      const created = new Map<string, string>();
      for (const [key, title] of plan.create) {
        const row = await q.query("INSERT INTO topics (conversation_id, title, title_source) VALUES ($1, $2, 'llm') RETURNING id", [conversationId, cleanText(title, 60) || FALLBACK_TITLE]);
        created.set(key, row.rows[0]!.id);
      }
      const from = new Map(rows.map((r) => [r.id, r.topicId]));
      const assignments: LaneUpdate["assignments"] = [];
      for (const [messageId, key] of plan.moves) {
        const target = created.get(key) ?? key;
        // Only if nothing changed underneath us: still there, still where the model saw it, not placed by a person since.
        const moved = await q.query(
          `UPDATE messages m SET topic_id = $2, topic_source = CASE WHEN m.topic_source = 'reply' THEN 'reply' ELSE 'llm' END, topic_score = NULL, rev = $3
            WHERE m.id = $1 AND m.conversation_id = $5 AND m.topic_id = $4 AND m.deleted_at IS NULL
              AND m.topic_source IS DISTINCT FROM 'user' AND m.topic_source IS DISTINCT FROM 'lane'
              AND EXISTS (SELECT 1 FROM topics t WHERE t.id = $2 AND t.conversation_id = $5)`,
          [messageId, target, rev, from.get(messageId), conversationId],
        );
        if (!moved.rowCount) continue;
        assignments.push({ messageId, topicId: target });
        affected.add(target).add(from.get(messageId)!);
      }
      for (const id of created.values()) affected.add(id); // an unused one is dropped just below
      if (affected.size === 0) {
        await q.query("UPDATE conversations SET rev = rev - 1 WHERE id = $1", [conversationId]); // nothing used the rev
        return nothing;
      }
      if (assignments.length > 0) {
        const movedIds = assignments.map((a) => a.messageId);
        // Questions follow their messages, and the lanes that changed need new summaries.
        await q.query("UPDATE topic_questions tq SET topic_id = m.topic_id FROM messages m WHERE m.id = tq.message_id AND tq.message_id = ANY($1)", [movedIds]);
        await q.query("UPDATE topics SET digest_through_seq = NULL WHERE id = ANY($1)", [[...affected]]);
      }
      const removed = await dropEmptyTopics(q, conversationId, [...affected]);
      const remaining = [...affected].filter((id) => !removed.includes(id));
      return { conversationId, rev, topics: await listTopics(q, conversationId, { only: remaining }), removed, assignments } satisfies LaneUpdate;
    });
  }

  /** A member overrides the topic's status, or (status null) hands it back to the digest. */
  async setStatus(topicId: string, userId: string, status: "open" | "decided" | null, outcome: string | null): Promise<LaneUpdate> {
    const { conversationId } = await requireTopicAccess(this.db, topicId, userId);
    await this.requireEnabled(conversationId);
    // The change and its record are written together or not at all.
    await this.db.tx(async (q) => {
      const before = await q.query("SELECT status, outcome, status_source FROM topics WHERE id = $1 FOR UPDATE", [topicId]);
      if (status === null) {
        // Forget the override and let the next digest decide again.
        await q.query("UPDATE topics SET status = NULL, outcome = NULL, status_source = NULL, digest_through_seq = NULL WHERE id = $1", [topicId]);
      } else {
        await q.query("UPDATE topics SET status = $2, outcome = $3, status_source = 'user' WHERE id = $1", [topicId, status, status === "decided" ? outcome : null]);
      }
      await q.query(
        `INSERT INTO topic_corrections (conversation_id, user_id, kind, to_topic_id, details) VALUES ($1, $2, 'status', $3, $4)`,
        [conversationId, userId, topicId, JSON.stringify({ from: before.rows[0] ?? null, to: { status, outcome: status === "decided" ? outcome : null } })],
      );
    });
    if (status === null) await this.run(topicId);
    const update: LaneUpdate = { conversationId, rev: null, topics: await listTopics(this.db, conversationId, { only: [topicId] }), removed: [], assignments: [] };
    await this.rt.toConversation(conversationId, "lanes:update", update);
    return update;
  }

  /**
   * The group admin's switch. Turning it on is announced in the chat, so every member
   * knows their messages now go to an outside provider. Turning it off deletes what
   * the provider produced.
   */
  async setEnabled(conversationId: string, actorId: string, enabled: boolean): Promise<string | null> {
    const messageId = await this.db.tx(async (q) => {
      await requireAdmin(q, conversationId, actorId);
      const c = await q.query("SELECT type, ai_enabled FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
      if (c.rows[0]?.type !== "group") throw badRequest("AI features are only available in groups");
      if (c.rows[0].ai_enabled === enabled) return null;
      await q.query("UPDATE conversations SET ai_enabled = $2, ai_enabled_by = $3, ai_enabled_at = now() WHERE id = $1", [conversationId, enabled, actorId]);
      if (!enabled) {
        await q.query("DELETE FROM topic_questions WHERE conversation_id = $1", [conversationId]);
        await q.query("UPDATE conversations SET tidy_through_seq = NULL WHERE id = $1", [conversationId]);
        await q.query(
          `UPDATE topics SET recap = NULL, digest_through_seq = NULL, digest_at = NULL, digest_model = NULL,
                  status = CASE WHEN status_source = 'user' THEN status END,
                  outcome = CASE WHEN status_source = 'user' THEN outcome END,
                  status_source = CASE WHEN status_source = 'user' THEN 'user' END
            WHERE conversation_id = $1`,
          [conversationId],
        );
      }
      const name = (await q.query("SELECT full_name FROM users WHERE id = $1", [actorId])).rows[0]?.full_name ?? "An admin";
      return systemLine(
        q,
        conversationId,
        actorId,
        enabled
          ? `${name} turned on AI features. Messages in this group are now sent to an outside AI provider (${this.model.providerLabel}) to sort and summarise topics.`
          : `${name} turned off AI features. Messages in this group are no longer sent to an outside AI provider.`,
      );
    });
    if (enabled && messageId) {
      // Tidy what is already there, then start with the topics people are most likely to look at.
      this.queue.enqueue(`digest:${conversationId}`, async () => {
        const changed = await this.tidy(conversationId).catch((err) => {
          console.error(`[tidy] conversation ${conversationId}: ${(err as Error).message}`);
          return [] as string[];
        });
        const recent = (await listTopics(this.db, conversationId)).slice(0, 5).map((t) => t.id);
        for (const topicId of new Set([...recent, ...changed])) await this.run(topicId);
      });
    }
    return messageId;
  }

  /** Questions put to this member that they have not answered or dismissed, newest first. */
  async inbox(userId: string): Promise<InboxItemDto[]> {
    const { rows } = await this.db.query(
      `SELECT q.id AS question_id, q.question, t.id AS q_topic_id, t.title AS topic_title, ${MESSAGE_COLUMNS}
         FROM topic_questions q
         JOIN messages m ON m.id = q.message_id AND m.deleted_at IS NULL
         JOIN topics t ON t.id = q.topic_id
         JOIN conversations c ON c.id = q.conversation_id AND c.ai_enabled
         -- Still a member: leaving a group empties its questions from your inbox.
         JOIN conversation_members cm ON cm.conversation_id = q.conversation_id AND cm.user_id = q.asked_of
        WHERE q.asked_of = $1 AND NOT q.answered AND q.dismissed_at IS NULL
          -- Replying to the question answers it, whatever the digest last thought.
          AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to_id = q.message_id AND r.sender_id = q.asked_of AND r.deleted_at IS NULL)
        ORDER BY m.created_at DESC LIMIT 100`,
      [userId],
    );
    return rows.map((r) => ({ id: r.question_id, question: r.question, topic: { id: r.q_topic_id, title: r.topic_title }, message: toMessageDto(r) }));
  }

  async dismiss(questionId: string, userId: string): Promise<void> {
    const { rowCount } = await this.db.query("UPDATE topic_questions SET dismissed_at = now() WHERE id = $1 AND asked_of = $2", [questionId, userId]);
    if (!rowCount) throw notFound("Question not found");
  }
}
