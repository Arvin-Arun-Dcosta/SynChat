import webpush from "web-push";
import type { Db } from "../db.js";
import type { Realtime } from "../realtime/realtime.js";

export interface PushPayload {
  title: string;
  body: string;
  conversationId: string;
  messageId: string;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Delivers one notification to one browser. Resolves "gone" when the subscription is dead. */
export interface PushSender {
  send(target: PushTarget, payload: PushPayload): Promise<"sent" | "gone">;
}

/** The Web Push protocol, signed with this server's VAPID keys. */
export class WebPushSender implements PushSender {
  constructor(private readonly vapid: { publicKey: string; privateKey: string; subject: string }) {}

  async send(target: PushTarget, payload: PushPayload): Promise<"sent" | "gone"> {
    try {
      await webpush.sendNotification(target, JSON.stringify(payload), {
        vapidDetails: this.vapid,
        TTL: 60 * 60, // a chat notification is not worth delivering a day late
        urgency: "high",
        topic: payload.conversationId.replace(/-/g, "").slice(0, 32), // a newer one for the same chat replaces a waiting one
      });
      return "sent";
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return "gone"; // the browser unsubscribed
      throw err;
    }
  }
}

/**
 * Decides who is notified about a new message, and sends it.
 *
 * Not notified: the sender; anyone looking at SynChat right now (they get it live);
 * and anyone who has muted the message's topic, unless the message mentions them.
 * For a group message this runs after the topic is known, which is why notifications
 * can honour topic mute at all.
 */
export class PushService {
  constructor(
    private readonly db: Db,
    private readonly rt: Realtime,
    private readonly sender: PushSender,
  ) {}

  async notifyMessage(messageId: string): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT m.id, m.conversation_id, m.sender_id, m.text, m.image_url IS NOT NULL AS has_image,
              c.type, c.name AS group_name, sender.full_name AS sender_name,
              s.id AS subscription_id, s.user_id, s.endpoint, s.p256dh, s.auth
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN users sender ON sender.id = m.sender_id
         -- Only current members of the conversation, and never the sender.
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id IS DISTINCT FROM m.sender_id
         JOIN users u ON u.id = cm.user_id
         JOIN push_subscriptions s ON s.user_id = cm.user_id
        WHERE m.id = $1 AND m.kind = 'user' AND m.deleted_at IS NULL
          -- Topic mute: skipped unless the message mentions this member, or they have
          -- switched topic mute off altogether.
          AND (m.topic_id IS NULL
               OR NOT coalesce((u.smart->>'topicMute')::boolean, true)
               OR NOT EXISTS (SELECT 1 FROM topic_mutes tm WHERE tm.user_id = cm.user_id AND tm.topic_id = m.topic_id)
               OR EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.user_id = cm.user_id))`,
      [messageId],
    );
    let sent = 0;
    await Promise.all(
      rows.map(async (r) => {
        if (this.rt.isLooking(r.user_id)) return; // they are watching it arrive
        const sender = r.sender_name ?? "Someone";
        const payload: PushPayload = {
          title: r.type === "group" ? `${sender} · ${r.group_name}` : sender,
          body: (r.text as string | null)?.slice(0, 140) || (r.has_image ? "Sent a photo" : "New message"),
          conversationId: r.conversation_id,
          messageId: r.id,
        };
        try {
          const result = await this.sender.send({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload);
          if (result === "gone") await this.db.query("DELETE FROM push_subscriptions WHERE id = $1", [r.subscription_id]);
          else sent++;
        } catch (err) {
          console.error("[push] delivery failed:", (err as Error).message);
        }
      }),
    );
    return sent;
  }
}
