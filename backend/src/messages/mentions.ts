import type { Queryable } from "../db.js";

const MENTION = /(?:^|[^\w@.])@([a-z0-9_.]{3,24})/gi;

/** Usernames written as @name in a message, lowercased, without trailing punctuation. */
export function mentionedUsernames(text: string | null | undefined): string[] {
  const found = new Set<string>();
  for (const m of (text ?? "").matchAll(MENTION)) found.add(m[1]!.toLowerCase().replace(/\.+$/, ""));
  return [...found].filter((u) => u.length >= 3);
}

/**
 * Record who a message mentions. Only members of the conversation can be mentioned,
 * so a mention never reveals whether some other username exists. Call in the
 * transaction that writes the message.
 */
export async function saveMentions(q: Queryable, messageId: string, conversationId: string, senderId: string, text: string | null): Promise<void> {
  await q.query("DELETE FROM message_mentions WHERE message_id = $1", [messageId]);
  const usernames = mentionedUsernames(text);
  if (usernames.length === 0) return;
  await q.query(
    `INSERT INTO message_mentions (message_id, user_id)
     SELECT $1, u.id FROM users u
       JOIN conversation_members cm ON cm.user_id = u.id AND cm.conversation_id = $2
      WHERE u.username = ANY($3::citext[]) AND u.id <> $4
     ON CONFLICT DO NOTHING`,
    [messageId, conversationId, usernames, senderId],
  );
}
