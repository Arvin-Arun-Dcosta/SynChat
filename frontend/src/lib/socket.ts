import { io, type Socket } from "socket.io-client";
import { API_ORIGIN } from "./api";
import { useAuthStore } from "../store/useAuthStore";
import { useChatStore } from "../store/useChatStore";
import { settingsBusy } from "../store/useSmartStore";
import type { Conversation, LaneUpdate, Me, Message } from "../types";

let socket: Socket | null = null;
let stopReporting: () => void = () => {};
const lastTypingSent = new Map<string, number>();

/**
 * Open the realtime connection. It carries no identity of its own: the server
 * authenticates it from the same httpOnly session cookie as every API call.
 */
export function connectSocket(): void {
  if (socket) return;
  const chat = () => useChatStore.getState();
  socket = API_ORIGIN ? io(API_ORIGIN, { withCredentials: true }) : io({ withCredentials: true });

  // Tell the server whether someone is actually looking, so it knows when a push
  // notification is needed on top of the live event.
  const reportLooking = () => socket?.emit("looking", document.visibilityState === "visible" && document.hasFocus());
  window.addEventListener("focus", reportLooking);
  window.addEventListener("blur", reportLooking);
  document.addEventListener("visibilitychange", reportLooking);
  stopReporting = () => {
    window.removeEventListener("focus", reportLooking);
    window.removeEventListener("blur", reportLooking);
    document.removeEventListener("visibilitychange", reportLooking);
  };

  socket.on("connect", () => {
    chat().setConnected(true);
    reportLooking();
    // Runs on the first connect and on every reconnect: whatever happened while we
    // were not listening is fetched over HTTP, then live events take over.
    void chat().resync();
    syncPresence();
  });
  socket.on("disconnect", () => chat().setConnected(false));
  socket.on("connect_error", (err) => {
    chat().setConnected(false);
    if (err.message === "unauthorized") void useAuthStore.getState().checkAuth();
  });

  socket.on("message:new", (e: { message: Message }) => chat().applyMessage(e.message, true));
  socket.on("message:updated", (e: { message: Message }) => chat().applyMessage(e.message, false));
  socket.on("lanes:update", (e: LaneUpdate) => chat().applyLaneUpdate(e));
  socket.on("inbox:update", () => void chat().loadInbox());
  socket.on("topic:mute", (e: { conversationId: string; topicId: string; muted: boolean }) => chat().applyTopicMute(e));
  // My settings changed on another device.
  socket.on("me:updated", (e: { user: Me }) => {
    if (!settingsBusy()) useAuthStore.getState().setUser(e.user);
    void chat().loadConversations().catch(() => {});
    void chat().loadInbox();
  });
  socket.on("conversation:updated", (e: { conversation: Conversation }) => {
    chat().upsertConversation(e.conversation);
    // Membership may have changed who I can see; refresh who is online.
    syncPresence();
  });
  socket.on("conversation:removed", (e: { conversationId: string }) => chat().removeConversation(e.conversationId));
  socket.on("read", (e: { conversationId: string; userId: string; lastReadSeq: number }) => chat().applyRead(e));
  socket.on("typing", (e: { conversationId: string; userId: string }) => chat().applyTyping(e));
  socket.on("presence", (e: { userId: string; online: boolean }) => chat().setPresence(e.userId, e.online));
}

function syncPresence(): void {
  socket?.emit("presence:sync", (res: { online: string[] }) => useChatStore.getState().setOnline(res.online));
}

export function disconnectSocket(): void {
  stopReporting();
  socket?.disconnect();
  socket = null;
  lastTypingSent.clear();
}

/** Tell the others in a conversation that I am typing, at most every two seconds. */
export function emitTyping(conversationId: string): void {
  const now = Date.now();
  if (now - (lastTypingSent.get(conversationId) ?? 0) < 2000) return;
  lastTypingSent.set(conversationId, now);
  socket?.emit("typing", { conversationId });
}

/** Call after sending, so typing the next message is announced straight away. */
export function resetTyping(conversationId: string): void {
  lastTypingSent.delete(conversationId);
}
