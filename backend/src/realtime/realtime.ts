import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { findSession, tokenFromCookieHeader } from "../auth/sessions.js";
import type { Config } from "../config.js";
import { getMembership, memberIds } from "../conversations/service.js";
import type { Db } from "../db.js";

const userRoom = (userId: string) => `user:${userId}`;
const sessionRoom = (sessionId: string) => `session:${sessionId}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SocketData {
  userId: string;
  sessionId: string;
  /** The client says its window is visible and focused. */
  looking?: boolean;
}
type AppSocket = Socket<Record<string, never>, Record<string, never>, Record<string, never>, SocketData>;

export interface RealtimeOptions {
  /** How long a user stays "online" after their last socket drops (covers page reloads). */
  presenceGraceMs?: number;
}

/**
 * The Socket.io layer. Sockets are authenticated from the session cookie during the
 * handshake; the client never tells us who it is. Each socket joins one room per
 * user, and everything is addressed to user rooms, so delivery always follows current
 * membership and works unchanged across several server instances once a Socket.io
 * adapter (e.g. Redis) is plugged in. Presence counts are the one piece of
 * instance-local state here and would move to the same shared store.
 */
export class Realtime {
  readonly io: Server;
  private readonly socketCount = new Map<string, number>();
  private readonly offlineTimers = new Map<string, NodeJS.Timeout>();
  private readonly presenceGraceMs: number;

  constructor(
    server: HttpServer,
    private readonly db: Db,
    private readonly config: Config,
    opts: RealtimeOptions = {},
  ) {
    this.presenceGraceMs = opts.presenceGraceMs ?? 4000;
    const allowed = new Set(config.clientOrigins);
    this.io = new Server(server, {
      cors: { origin: config.clientOrigins, credentials: true },
      // WebSocket handshakes are not covered by CORS, so check the Origin ourselves.
      allowRequest: (req, done) => {
        const origin = req.headers.origin;
        let ok = !origin || allowed.has(origin);
        if (!ok && origin) {
          try {
            ok = new URL(origin).host === req.headers.host;
          } catch {
            ok = false;
          }
        }
        done(null, ok);
      },
    });

    this.io.use(async (socket, next) => {
      try {
        const token = tokenFromCookieHeader(socket.handshake.headers.cookie);
        const session = await findSession(this.db, token, this.config.sessionTtlMs);
        if (!session) return next(new Error("unauthorized"));
        (socket as AppSocket).data = { userId: session.user.id, sessionId: session.sessionId };
        next();
      } catch (err) {
        console.error("[rt] handshake failed:", (err as Error).message);
        next(new Error("unavailable"));
      }
    });

    this.io.on("connection", (socket) => this.onConnection(socket as AppSocket));
  }

  private onConnection(socket: AppSocket): void {
    const { userId, sessionId } = socket.data;
    void socket.join([userRoom(userId), sessionRoom(sessionId)]);
    void this.cameOnline(userId);

    // Flood guard: a well-behaved client sends one every two seconds, plus one right
    // after each message. Allow a small burst, drop the rest.
    const typingWindow = new Map<string, { start: number; count: number }>();
    socket.on("typing", async (payload: unknown) => {
      const conversationId = (payload as { conversationId?: unknown } | null)?.conversationId;
      if (typeof conversationId !== "string" || !UUID.test(conversationId)) return;
      const now = Date.now();
      let w = typingWindow.get(conversationId);
      if (!w || now - w.start > 2000) typingWindow.set(conversationId, (w = { start: now, count: 0 }));
      if (++w.count > 4) return;
      try {
        if (!(await getMembership(this.db, conversationId, userId))) return;
        await this.toConversation(conversationId, "typing", { conversationId, userId }, { except: userId });
      } catch (err) {
        console.error("[rt] typing failed:", (err as Error).message);
      }
    });

    // Which of the people I share a conversation with are online right now.
    socket.on("presence:sync", async (ack: unknown) => {
      if (typeof ack !== "function") return;
      try {
        const contacts = await this.contactsOf(userId);
        ack({ online: contacts.filter((id) => this.isOnline(id)) });
      } catch {
        ack({ online: [] });
      }
    });

    // The client reports whether someone is actually looking at it. Used to decide
    // whether a push notification is needed on top of the live event.
    socket.on("looking", (value: unknown) => {
      socket.data.looking = value === true;
    });

    socket.on("disconnect", () => this.wentOffline(userId));
  }

  /** Is this person looking at SynChat on any device right now? */
  isLooking(userId: string): boolean {
    const sockets = this.io.sockets.adapter.rooms.get(userRoom(userId));
    if (!sockets) return false;
    for (const id of sockets) if ((this.io.sockets.sockets.get(id) as AppSocket | undefined)?.data.looking) return true;
    return false;
  }

  isOnline(userId: string): boolean {
    return (this.socketCount.get(userId) ?? 0) > 0 || this.offlineTimers.has(userId);
  }

  private async contactsOf(userId: string): Promise<string[]> {
    const { rows } = await this.db.query(
      `SELECT DISTINCT other.user_id
         FROM conversation_members mine
         JOIN conversation_members other USING (conversation_id)
        WHERE mine.user_id = $1 AND other.user_id <> $1`,
      [userId],
    );
    return rows.map((r) => r.user_id as string);
  }

  /** Presence is only ever told to people who share a conversation with the user. */
  private async announcePresence(userId: string, online: boolean): Promise<void> {
    try {
      this.toUsers(await this.contactsOf(userId), "presence", { userId, online });
    } catch (err) {
      console.error("[rt] presence failed:", (err as Error).message);
    }
  }

  private async cameOnline(userId: string): Promise<void> {
    const pending = this.offlineTimers.get(userId);
    if (pending) {
      clearTimeout(pending);
      this.offlineTimers.delete(userId);
    }
    const count = (this.socketCount.get(userId) ?? 0) + 1;
    this.socketCount.set(userId, count);
    // Only the first device (and not a quick reconnect) is a change worth announcing.
    if (count === 1 && !pending) await this.announcePresence(userId, true);
  }

  private wentOffline(userId: string): void {
    const count = (this.socketCount.get(userId) ?? 1) - 1;
    if (count > 0) {
      this.socketCount.set(userId, count);
      return;
    }
    this.socketCount.delete(userId);
    const timer = setTimeout(() => {
      this.offlineTimers.delete(userId);
      if (!this.socketCount.has(userId)) void this.announcePresence(userId, false);
    }, this.presenceGraceMs);
    timer.unref();
    this.offlineTimers.set(userId, timer);
  }

  toUsers(userIds: string[], event: string, payload: unknown, opts: { except?: string } = {}): void {
    const rooms = userIds.filter((id) => id !== opts.except).map(userRoom);
    if (rooms.length > 0) this.io.to(rooms).emit(event, payload);
  }

  /** Emit to every current member of a conversation, on all of their devices. */
  async toConversation(conversationId: string, event: string, payload: unknown, opts: { except?: string } = {}): Promise<void> {
    this.toUsers(await memberIds(this.db, conversationId), event, payload, opts);
  }

  /** Drop the sockets that were opened with a session that has just been revoked. */
  disconnectSession(sessionId: string): void {
    this.io.in(sessionRoom(sessionId)).disconnectSockets(true);
  }

  async close(): Promise<void> {
    for (const t of this.offlineTimers.values()) clearTimeout(t);
    this.offlineTimers.clear();
    await this.io.close();
  }
}
