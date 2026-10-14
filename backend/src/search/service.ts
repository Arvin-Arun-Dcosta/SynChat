import type { Db } from "../db.js";
import { toSqlVector, type Embedder } from "../embedding/embedder.js";
import { analyseText } from "../lanes/text.js";
import { MESSAGE_COLUMNS, toMessageDto } from "../messages/service.js";
import type { MessageDto } from "../types.js";

export interface SearchHit {
  message: MessageDto;
  /** Which search found it: exact words, meaning, or both. */
  matched: "keyword" | "meaning" | "both";
  score: number;
}

export interface SearchGroup {
  conversationId: string;
  /** The topic lane the hits are in; null for DMs and for messages without a topic. */
  topic: { id: string; title: string } | null;
  score: number;
  hits: SearchHit[];
}

export interface SearchResult {
  query: string;
  /** False when the embedding model was unavailable and only keywords were searched. */
  semantic: boolean;
  groups: SearchGroup[];
}

const CANDIDATES = 40;
/** Reciprocal rank fusion constant; 60 is the value from the original paper and the usual default. */
const RRF_K = 60;
/** Meaning matches weaker than this, or much weaker than the best one, are noise. */
const MIN_SIMILARITY = 0.3;
const SIMILARITY_WINDOW = 0.25;

/**
 * An OR of prefix matches on each word: "ramen book" finds "ramen", "booked", "booking".
 * Filler words ("where", "are", "we", "this") are left out when the query has anything
 * else in it: matching them would drown the real hits, and meaning search covers them.
 */
export function toTsQuery(q: string): string | null {
  const all = q.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((w) => w.length >= 2) ?? [];
  const content = new Set(analyseText(q).content);
  // `content` holds stemmed forms, so compare stems; keep the typed word for the query.
  const meaningful = all.filter((w) => content.has(w) || content.has(w.replace(/s$/, "")));
  const words = [...new Set(meaningful.length > 0 ? meaningful : all)].slice(0, 12);
  return words.length > 0 ? words.map((w) => `'${w}':*`).join(" | ") : null;
}

/**
 * Search the caller's conversations two ways and merge the rankings:
 *   keyword  Postgres full-text search on the message text
 *   meaning  nearest neighbours of the query's embedding (pgvector, HNSW)
 * Either list alone misses things the other finds ("where are we eating" has no word
 * in common with "ramen place near the station"; a name or a number has no meaning to
 * embed). Reciprocal rank fusion combines them without needing comparable scores.
 *
 * Both queries join conversation_members for the caller, so nothing outside their
 * own conversations can ever be returned.
 */
export async function search(db: Db, embedder: Embedder | null, userId: string, query: string, limit: number): Promise<SearchResult> {
  const tsQuery = toTsQuery(query);
  const keyword = tsQuery
    ? (
        await db.query(
          `SELECT m.id FROM messages m
             JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
            WHERE m.tsv @@ to_tsquery('simple', $2) AND m.deleted_at IS NULL AND m.kind = 'user'
            ORDER BY ts_rank(m.tsv, to_tsquery('simple', $2)) DESC, m.created_at DESC
            LIMIT ${CANDIDATES}`,
          [userId, tsQuery],
        )
      ).rows.map((r) => r.id as string)
    : [];

  let meaning: string[] = [];
  let semantic = false;
  if (embedder) {
    try {
      const [vector] = await embedder.embed([query]);
      if (vector) {
        const rows = await db.tx(async (q) => {
          // With a membership filter, a plain index scan can come back short: the
          // nearest vectors overall may all be in other people's conversations.
          // Iterative scan keeps going until enough rows pass the filter.
          await q.query("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
          return (
            await q.query(
              `SELECT e.message_id, 1 - (e.embedding <=> $2::vector) AS sim
                 FROM message_embeddings e
                 JOIN conversation_members cm ON cm.conversation_id = e.conversation_id AND cm.user_id = $1
                 JOIN messages m ON m.id = e.message_id AND m.deleted_at IS NULL
                ORDER BY e.embedding <=> $2::vector
                LIMIT ${CANDIDATES}`,
              [userId, toSqlVector(vector)],
            )
          ).rows;
        });
        const best = rows[0] ? Number(rows[0].sim) : 0;
        const floor = Math.max(MIN_SIMILARITY, best - SIMILARITY_WINDOW);
        meaning = rows.filter((r) => Number(r.sim) >= floor).map((r) => r.message_id as string);
        semantic = true;
      }
    } catch (err) {
      console.error("[search] meaning search unavailable:", (err as Error).message);
    }
  }

  // Reciprocal rank fusion.
  const scores = new Map<string, { score: number; keyword: boolean; meaning: boolean }>();
  const add = (ids: string[], kind: "keyword" | "meaning") =>
    ids.forEach((id, rank) => {
      const s = scores.get(id) ?? { score: 0, keyword: false, meaning: false };
      s.score += 1 / (RRF_K + rank + 1);
      s[kind] = true;
      scores.set(id, s);
    });
  add(keyword, "keyword");
  add(meaning, "meaning");
  const top = [...scores].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
  if (top.length === 0) return { query, semantic, groups: [] };

  // Load the winners. The membership join is repeated here: this is the query whose
  // rows actually leave the server.
  const { rows } = await db.query(
    `SELECT ${MESSAGE_COLUMNS}, t.title AS topic_title
       FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
       LEFT JOIN topics t ON t.id = m.topic_id
      WHERE m.id = ANY($2) AND m.deleted_at IS NULL`,
    [userId, top.map(([id]) => id)],
  );
  const byId = new Map(rows.map((r) => [r.id as string, r]));

  const groups = new Map<string, SearchGroup>();
  for (const [id, s] of top) {
    const row = byId.get(id);
    if (!row) continue;
    const message = toMessageDto(row);
    const key = `${message.conversationId}:${message.topicId ?? ""}`;
    const group = groups.get(key) ?? {
      conversationId: message.conversationId,
      topic: message.topicId ? { id: message.topicId, title: row.topic_title as string } : null,
      score: 0,
      hits: [],
    };
    group.hits.push({ message, matched: s.keyword && s.meaning ? "both" : s.keyword ? "keyword" : "meaning", score: s.score });
    group.score = Math.max(group.score, s.score);
    groups.set(key, group);
  }
  return { query, semantic, groups: [...groups.values()].sort((a, b) => b.score - a.score) };
}
