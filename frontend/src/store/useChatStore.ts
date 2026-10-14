import { create } from "zustand";
import { api, errorMessage, isTransient } from "../lib/api";
import type { Conversation, InboxItem, LaneUpdate, Message, PendingMessage, Topic } from "../types";
import { useAuthStore } from "./useAuthStore";
import { useConfigStore } from "./useConfigStore";
import { smartNow } from "./useSmartStore";

const PAGE = 50;
const MAX_ATTEMPTS = 6;
const TYPING_MS = 4500;

/** Messages loaded for one conversation: a gap-free run ending at the newest. */
export interface ConvState {
  messages: Message[];
  pending: PendingMessage[];
  hasMore: boolean;
  loadingOlder: boolean;
  /** Every change up to this conversation rev has been applied locally. */
  syncedRev: number;
}

/** What the chat pane is showing for a group: everything, the list of lanes, or one lane. */
export type View = { mode: "chat" } | { mode: "topics" } | { mode: "lane"; topicId: string };

/** The messages of the one lane that is open, loaded separately from the mixed chat. */
export interface LaneState {
  conversationId: string;
  topicId: string;
  messages: Message[];
  hasMore: boolean;
  loadingOlder: boolean;
  loaded: boolean;
}

interface ChatState {
  conversations: Record<string, Conversation>;
  listLoaded: boolean;
  byConv: Record<string, ConvState | undefined>;
  activeId: string | null;
  online: Record<string, true>;
  /** conversationId -> userId -> time the indicator expires */
  typing: Record<string, Record<string, number>>;
  connected: boolean;

  loadConversations: () => Promise<void>;
  upsertConversation: (c: Conversation) => void;
  removeConversation: (id: string) => void;
  setActive: (id: string | null) => void;
  loadOlder: (id: string) => Promise<void>;
  /** conversationId -> topicId -> topic. Present once a group's lanes have been loaded. */
  topics: Record<string, Record<string, Topic> | undefined>;
  view: Record<string, View | undefined>;
  lane: LaneState | null;
  loadTopics: (conversationId: string) => Promise<void>;
  setView: (conversationId: string, view: View) => void;
  loadOlderLane: () => Promise<void>;
  applyLaneUpdate: (u: LaneUpdate) => void;
  moveMessage: (m: Message, target: { topicId: string } | { title?: string }) => Promise<void>;
  mergeTopic: (fromTopicId: string, intoTopicId: string) => Promise<void>;
  renameTopic: (topicId: string, title: string) => Promise<void>;
  setTopicMuted: (conversationId: string, topicId: string, muted: boolean) => Promise<void>;
  applyTopicMute: (e: { conversationId: string; topicId: string; muted: boolean }) => void;
  /**
   * Per conversation: how far I had read when I opened it this time. Opening a chat
   * marks it read at once, so "what did I miss" has to be measured from here.
   */
  awaySince: Record<string, number | undefined>;
  /** Ask for an up-to-date AI digest of a topic (catch-up on demand). */
  refreshDigest: (topicId: string) => Promise<void>;
  setTopicStatus: (topicId: string, status: "open" | "decided" | null, outcome?: string) => Promise<void>;
  /** Questions put to me that I have not answered, across all chats. */
  inbox: InboxItem[];
  loadInbox: () => Promise<void>;
  dismissQuestion: (id: string) => Promise<void>;
  /** A message to scroll to and flash, set when a search result is opened. */
  reveal: { conversationId: string; messageId: string; nonce: number } | null;
  revealMessage: (m: Message) => Promise<void>;
  /** Per conversation: the message being replied to, or being edited, in the composer. */
  replyingTo: Record<string, Message | undefined>;
  editing: Record<string, Message | undefined>;
  setReplyingTo: (conversationId: string, m: Message | undefined) => void;
  setEditing: (conversationId: string, m: Message | undefined) => void;
  send: (conversationId: string, text: string, opts?: { replyTo?: Message | null; image?: PendingMessage["image"]; topicId?: string }) => void;
  editMessage: (m: Message, text: string) => Promise<void>;
  deleteMessage: (m: Message) => Promise<void>;
  toggleReaction: (m: Message, emoji: string) => Promise<void>;
  retry: (conversationId: string, id: string) => void;
  discard: (conversationId: string, id: string) => void;
  applyMessage: (m: Message, isNew: boolean) => void;
  syncConversation: (id: string) => Promise<void>;
  resync: () => Promise<void>;
  markRead: (id: string) => void;
  applyRead: (e: { conversationId: string; userId: string; lastReadSeq: number }) => void;
  applyTyping: (e: { conversationId: string; userId: string }) => void;
  setPresence: (userId: string, online: boolean) => void;
  setOnline: (ids: string[]) => void;
  setConnected: (connected: boolean) => void;
  reset: () => void;
}

const meId = () => useAuthStore.getState().user?.id;

/** Does this message stay out of my unread badge because I muted its topic? A mention gets through. */
function silenced(m: Message, c: Conversation): boolean {
  if (!m.topicId || !smartNow("topicMute")) return false;
  return c.mutedTopicIds.includes(m.topicId) && !m.mentions.includes(meId() ?? "");
}

// Conversations whose unread badge should be re-read from the server shortly.
const recountTimers = new Map<string, ReturnType<typeof setTimeout>>();
const isLooking = () => document.visibilityState === "visible" && document.hasFocus();

// Highest rev seen per conversation, to notice a gap between it and syncedRev.
const maxSeenRev = new Map<string, number>();
const syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
const syncing = new Set<string>();

/** Insert or replace by id, keeping the list ordered by seq. A stale copy never wins. */
function upsert(list: Message[], m: Message): Message[] {
  const at = list.findIndex((x) => x.id === m.id);
  if (at >= 0) {
    if (list[at]!.rev > m.rev) return list;
    const next = list.slice();
    next[at] = m;
    return next;
  }
  const last = list[list.length - 1];
  if (!last || last.seq < m.seq) return [...list, m];
  const next = list.slice();
  const before = next.findIndex((x) => x.seq > m.seq);
  next.splice(before === -1 ? next.length : before, 0, m);
  return next;
}

const initial = {
  conversations: {} as Record<string, Conversation>,
  listLoaded: false,
  byConv: {} as Record<string, ConvState | undefined>,
  activeId: null as string | null,
  online: {} as Record<string, true>,
  typing: {} as Record<string, Record<string, number>>,
  connected: false,
  replyingTo: {} as Record<string, Message | undefined>,
  editing: {} as Record<string, Message | undefined>,
  topics: {} as Record<string, Record<string, Topic> | undefined>,
  view: {} as Record<string, View | undefined>,
  lane: null as LaneState | null,
  reveal: null as { conversationId: string; messageId: string; nonce: number } | null,
  inbox: [] as InboxItem[],
  awaySince: {} as Record<string, number | undefined>,
};

export const useChatStore = create<ChatState>((set, get) => {
  const patchConversation = (id: string, fn: (c: Conversation) => Conversation) =>
    set((s) => {
      const c = s.conversations[id];
      return c ? { conversations: { ...s.conversations, [id]: fn(c) } } : s;
    });

  const patchConv = (id: string, fn: (cs: ConvState) => ConvState) =>
    set((s) => {
      const cs = s.byConv[id];
      return cs ? { byConv: { ...s.byConv, [id]: fn(cs) } } : s;
    });

  const loadLatest = async (id: string) => {
    const { data } = await api.get<{ messages: Message[]; rev: number; hasMore: boolean }>(`/conversations/${id}/messages`, {
      params: { limit: PAGE },
    });
    set((s) => {
      const prev = s.byConv[id];
      // Keep anything newer that arrived over the socket while the page was loading.
      const firstSeq = data.messages[0]?.seq ?? 0;
      let messages = data.messages;
      for (const m of prev?.messages ?? []) if (m.seq >= firstSeq) messages = upsert(messages, m);
      return {
        byConv: {
          ...s.byConv,
          [id]: { messages, pending: prev?.pending ?? [], hasMore: data.hasMore, loadingOlder: false, syncedRev: data.rev },
        },
      };
    });
  };

  const scheduleSync = (id: string) => {
    if (syncTimers.has(id)) return;
    syncTimers.set(
      id,
      setTimeout(() => {
        syncTimers.delete(id);
        const cs = get().byConv[id];
        // Skip if the missing events turned up on their own in the meantime.
        if (cs && (maxSeenRev.get(id) ?? 0) > cs.syncedRev) void get().syncConversation(id);
      }, 250),
    );
  };

  const attemptSend = async (p: PendingMessage, attempt: number) => {
    try {
      if (p.image && !p.image.uploadId) {
        const form = new FormData();
        form.append("width", String(p.image.width));
        form.append("height", String(p.image.height));
        form.append("image", p.image.file);
        const { data } = await api.post<{ upload: { id: string } }>("/uploads/image", form, { timeout: 60_000 });
        // Remember the upload so a retry of the send does not upload the file again.
        p = { ...p, image: { ...p.image, uploadId: data.upload.id } };
        const uploaded = p;
        patchConv(p.conversationId, (cs) => ({ ...cs, pending: cs.pending.map((x) => (x.id === uploaded.id ? uploaded : x)) }));
      }
      // The id is ours, so repeating this request can never create a second message.
      const { data } = await api.post<{ message: Message }>(`/conversations/${p.conversationId}/messages`, {
        id: p.id,
        text: p.text || null,
        imageId: p.image?.uploadId ?? null,
        replyToId: p.replyTo?.id ?? null,
        topicId: p.topicId ?? null,
      });
      get().applyMessage(data.message, true);
      if (p.image) URL.revokeObjectURL(p.image.previewUrl);
    } catch (err) {
      const stillPending = get().byConv[p.conversationId]?.pending.some((x) => x.id === p.id);
      if (!stillPending) return; // confirmed over the socket, or discarded
      if (isTransient(err) && attempt + 1 < MAX_ATTEMPTS) {
        setTimeout(() => void attemptSend(p, attempt + 1), Math.min(1000 * 2 ** attempt, 15_000));
        return;
      }
      patchConv(p.conversationId, (cs) => ({
        ...cs,
        pending: cs.pending.map((x) => (x.id === p.id ? { ...x, status: "failed", error: errorMessage(err, "Not sent") } : x)),
      }));
    }
  };

  return {
    ...initial,

    loadConversations: async () => {
      const { data } = await api.get<{ conversations: Conversation[] }>("/conversations");
      set((s) => {
        const conversations = Object.fromEntries(data.conversations.map((c) => [c.id, c]));
        const activeId = s.activeId && conversations[s.activeId] ? s.activeId : null;
        return { conversations, listLoaded: true, activeId };
      });
    },

    upsertConversation: (c) => {
      const before = get().conversations[c.id];
      set((s) => ({ conversations: { ...s.conversations, [c.id]: c } }));
      // AI features were switched on or off for the group: its topics gain or lose their digests.
      if (before && before.aiEnabled !== c.aiEnabled) {
        if (get().topics[c.id]) void get().loadTopics(c.id).catch(() => {});
        void get().loadInbox();
      }
    },

    removeConversation: (id) =>
      set((s) => {
        const { [id]: _gone, ...conversations } = s.conversations;
        const { [id]: _state, ...byConv } = s.byConv;
        return { conversations, byConv, activeId: s.activeId === id ? null : s.activeId };
      }),

    setActive: (id) => {
      const previous = get().activeId;
      if (id !== previous) {
        const opening = id ? get().conversations[id] : undefined;
        set((s) => {
          const { [previous ?? ""]: _left, ...rest } = s.awaySince;
          return { awaySince: opening && opening.unreadCount > 0 ? { ...rest, [opening.id]: opening.myLastReadSeq } : rest };
        });
      }
      set({ activeId: id });
      if (!id) return;
      if (!get().byConv[id]) {
        void loadLatest(id)
          .then(() => get().markRead(id))
          .catch(() => {});
      } else {
        get().markRead(id);
      }
    },

    loadOlder: async (id) => {
      const cs = get().byConv[id];
      const first = cs?.messages[0];
      if (!cs || !first || !cs.hasMore || cs.loadingOlder) return;
      patchConv(id, (x) => ({ ...x, loadingOlder: true }));
      try {
        const { data } = await api.get<{ messages: Message[]; hasMore: boolean }>(`/conversations/${id}/messages`, {
          params: { limit: PAGE, before: first.seq },
        });
        patchConv(id, (x) => ({
          ...x,
          messages: [...data.messages.filter((m) => m.seq < (x.messages[0]?.seq ?? Infinity)), ...x.messages],
          hasMore: data.hasMore,
          loadingOlder: false,
        }));
      } catch {
        patchConv(id, (x) => ({ ...x, loadingOlder: false }));
      }
    },

    send: (conversationId, text, opts = {}) => {
      const r = opts.replyTo;
      const pending: PendingMessage = {
        id: crypto.randomUUID(),
        conversationId,
        text,
        replyTo: r ? { id: r.id, senderId: r.senderId, text: r.text, hasImage: r.image !== null, deleted: r.deleted } : null,
        image: opts.image,
        topicId: opts.topicId,
        createdAt: new Date().toISOString(),
        status: "sending",
      };
      patchConv(conversationId, (cs) => ({ ...cs, pending: [...cs.pending, pending] }));
      void attemptSend(pending, 0);
    },

    retry: (conversationId, id) => {
      const p = get().byConv[conversationId]?.pending.find((x) => x.id === id);
      if (!p) return;
      const again: PendingMessage = { ...p, status: "sending", error: undefined };
      patchConv(conversationId, (cs) => ({ ...cs, pending: cs.pending.map((x) => (x.id === id ? again : x)) }));
      void attemptSend(again, 0);
    },

    discard: (conversationId, id) =>
      patchConv(conversationId, (cs) => ({ ...cs, pending: cs.pending.filter((x) => x.id !== id) })),

    loadTopics: async (conversationId) => {
      const { data } = await api.get<{ topics: Topic[] }>(`/conversations/${conversationId}/topics`);
      set((s) => ({ topics: { ...s.topics, [conversationId]: Object.fromEntries(data.topics.map((t) => [t.id, t])) } }));
    },

    setView: (conversationId, view) => {
      set((s) => ({ view: { ...s.view, [conversationId]: view }, lane: view.mode === "lane" ? s.lane : null }));
      if (view.mode === "chat") return;
      if (!get().topics[conversationId] || view.mode === "topics") void get().loadTopics(conversationId).catch(() => {});
      if (view.mode !== "lane") return;
      const topicId = view.topicId;
      set({ lane: { conversationId, topicId, messages: [], hasMore: false, loadingOlder: false, loaded: false } });
      void api
        .get<{ messages: Message[]; hasMore: boolean }>(`/conversations/${conversationId}/messages`, { params: { topicId, limit: PAGE } })
        .then(({ data }) => {
          const lane = get().lane;
          if (lane?.topicId !== topicId) return; // the user moved on
          set({ lane: { ...lane, messages: data.messages, hasMore: data.hasMore, loaded: true } });
        })
        .catch(() => {});
    },

    loadOlderLane: async () => {
      const lane = get().lane;
      const first = lane?.messages[0];
      if (!lane || !first || !lane.hasMore || lane.loadingOlder) return;
      set({ lane: { ...lane, loadingOlder: true } });
      try {
        const { data } = await api.get<{ messages: Message[]; hasMore: boolean }>(`/conversations/${lane.conversationId}/messages`, {
          params: { topicId: lane.topicId, limit: PAGE, before: first.seq },
        });
        const now = get().lane;
        if (now?.topicId !== lane.topicId) return;
        set({ lane: { ...now, messages: [...data.messages.filter((m) => m.seq < (now.messages[0]?.seq ?? Infinity)), ...now.messages], hasMore: data.hasMore, loadingOlder: false } });
      } catch {
        const now = get().lane;
        if (now?.topicId === lane.topicId) set({ lane: { ...now, loadingOlder: false } });
      }
    },

    applyLaneUpdate: (u) => {
      const id = u.conversationId;
      const state = get();
      const conversation = state.conversations[id];
      if (!conversation) return;
      const cs = state.byConv[id];
      const assigned = new Map(u.assignments.map((a) => [a.messageId, a.topicId]));
      const rev = u.rev;
      // Stamp the moved messages with their new topic (and rev, so a stale copy cannot undo it).
      const restamp = (m: Message): Message => {
        const topicId = assigned.get(m.id);
        return topicId === undefined || (rev !== null && m.rev > rev) ? m : { ...m, topicId, rev: rev ?? m.rev };
      };

      if (cs && assigned.size > 0) {
        patchConv(id, (x) => ({
          ...x,
          messages: x.messages.map(restamp),
          syncedRev: rev !== null && rev === x.syncedRev + 1 ? rev : x.syncedRev,
        }));
        if (rev !== null) {
          maxSeenRev.set(id, Math.max(maxSeenRev.get(id) ?? 0, rev));
          if (rev > (get().byConv[id]?.syncedRev ?? 0)) scheduleSync(id);
        }
      }

      // A message is counted as unread the moment it arrives, before its topic is known.
      // If it has now been placed in a topic I muted, the badge is too high. The server
      // knows the right number (it also knows about mentions), so ask it.
      if (smartNow("topicMute") && u.assignments.some((a) => conversation.mutedTopicIds.includes(a.topicId)) && !recountTimers.has(id)) {
        recountTimers.set(
          id,
          setTimeout(() => {
            recountTimers.delete(id);
            void api
              .get<{ conversation: Conversation }>(`/conversations/${id}`)
              .then(({ data }) => {
                const current = get().conversations[id];
                // Keep what the client knows better: reading the open chat zeroes the badge locally first.
                if (current) patchConversation(id, (c) => ({ ...c, unreadCount: Math.min(data.conversation.unreadCount, c.lastSeq > c.myLastReadSeq ? Infinity : 0) }));
              })
              .catch(() => {});
          }, 300),
        );
      }

      const known = state.topics[id];
      if (known) {
        const next = { ...known };
        for (const gone of u.removed) delete next[gone];
        for (const t of u.topics) {
          // Unread counts are per person; events are for everyone. Keep ours, and count
          // a newly placed message I have not read yet.
          let unread = known[t.id]?.unreadCount ?? 0;
          for (const a of u.assignments) {
            if (a.topicId !== t.id) continue;
            const m = cs?.messages.find((x) => x.id === a.messageId);
            // Only a first placement counts: not a move between lanes, and not this
            // same update arriving twice (once as our own response, once as the event).
            if (m && m.topicId === null && m.senderId !== meId() && m.seq > conversation.myLastReadSeq) unread++;
          }
          next[t.id] = { ...t, unreadCount: unread, muted: known[t.id]?.muted ?? conversation.mutedTopicIds.includes(t.id) };
        }
        set((s) => ({ topics: { ...s.topics, [id]: next } }));
      }

      const lane = get().lane;
      if (lane && lane.conversationId === id) {
        if (u.removed.includes(lane.topicId)) {
          // The open lane was merged away or emptied: follow its messages, or fall back to the list.
          const target = u.assignments[0]?.topicId;
          get().setView(id, target ? { mode: "lane", topicId: target } : { mode: "topics" });
        } else if (lane.loaded && assigned.size > 0) {
          let messages = lane.messages.filter((m) => assigned.get(m.id) === undefined || assigned.get(m.id) === lane.topicId).map(restamp);
          let missing = false;
          for (const [messageId, topicId] of assigned) {
            if (topicId !== lane.topicId || messages.some((m) => m.id === messageId)) continue;
            const m = get().byConv[id]?.messages.find((x) => x.id === messageId);
            if (m) messages = upsert(messages, m);
            else missing = true;
          }
          if (missing) get().setView(id, { mode: "lane", topicId: lane.topicId });
          else set({ lane: { ...lane, messages } });
        }
      }
    },

    moveMessage: async (m, target) => {
      const { data } = await api.post<LaneUpdate>(`/messages/${m.id}/topic`, target);
      get().applyLaneUpdate(data);
    },

    mergeTopic: async (fromTopicId, intoTopicId) => {
      const { data } = await api.post<LaneUpdate>(`/topics/${fromTopicId}/merge`, { intoTopicId });
      get().applyLaneUpdate(data);
    },

    renameTopic: async (topicId, title) => {
      const { data } = await api.patch<LaneUpdate>(`/topics/${topicId}`, { title });
      get().applyLaneUpdate(data);
    },

    refreshDigest: async (topicId) => {
      const { data } = await api.post<LaneUpdate>(`/topics/${topicId}/digest`, undefined, { timeout: 70_000 });
      get().applyLaneUpdate(data);
    },

    setTopicStatus: async (topicId, status, outcome) => {
      const { data } = await api.patch<LaneUpdate>(`/topics/${topicId}/status`, { status, outcome: outcome ?? null }, { timeout: 70_000 });
      get().applyLaneUpdate(data);
    },

    loadInbox: async () => {
      // Only exists on a server with AI configured, for people who have not switched it off.
      await useConfigStore.getState().load();
      if (!useConfigStore.getState().features.llm || !smartNow("inbox")) return set({ inbox: [] });
      try {
        const { data } = await api.get<{ questions: InboxItem[] }>("/inbox");
        set({ inbox: data.questions });
      } catch {
        /* keep what we have */
      }
    },

    dismissQuestion: async (id) => {
      const before = get().inbox;
      set({ inbox: before.filter((q) => q.id !== id) });
      try {
        await api.post(`/inbox/${id}/dismiss`);
      } catch (err) {
        set({ inbox: before });
        throw err;
      }
    },

    setTopicMuted: async (conversationId, topicId, muted) => {
      get().applyTopicMute({ conversationId, topicId, muted });
      try {
        const { data } = await api.put<{ conversation: Conversation }>(`/topics/${topicId}/mute`, { muted });
        get().upsertConversation(data.conversation); // the recounted unread badge
      } catch (err) {
        get().applyTopicMute({ conversationId, topicId, muted: !muted });
        throw err;
      }
    },

    applyTopicMute: ({ conversationId, topicId, muted }) =>
      set((s) => {
        const t = s.topics[conversationId]?.[topicId];
        const c = s.conversations[conversationId];
        return {
          topics: t ? { ...s.topics, [conversationId]: { ...s.topics[conversationId], [topicId]: { ...t, muted } } } : s.topics,
          conversations: c
            ? { ...s.conversations, [conversationId]: { ...c, mutedTopicIds: muted ? [...new Set([...c.mutedTopicIds, topicId])] : c.mutedTopicIds.filter((x) => x !== topicId) } }
            : s.conversations,
        };
      }),

    revealMessage: async (m) => {
      const id = m.conversationId;
      get().setView(id, { mode: "chat" });
      get().setActive(id);
      // Wait for the first page, then page back until the message is in the list.
      for (let i = 0; i < 100 && !get().byConv[id]; i++) await new Promise((r) => setTimeout(r, 50));
      for (let page = 0; page < 40; page++) {
        const cs = get().byConv[id];
        if (!cs || cs.messages.some((x) => x.id === m.id) || !cs.hasMore) break;
        await get().loadOlder(id);
      }
      const nonce = Date.now();
      set({ reveal: { conversationId: id, messageId: m.id, nonce } });
      setTimeout(() => set((s) => (s.reveal?.nonce === nonce ? { reveal: null } : s)), 2500);
    },

    setReplyingTo: (conversationId, m) =>
      set((s) => ({ replyingTo: { ...s.replyingTo, [conversationId]: m }, editing: { ...s.editing, [conversationId]: undefined } })),
    setEditing: (conversationId, m) =>
      set((s) => ({ editing: { ...s.editing, [conversationId]: m }, replyingTo: { ...s.replyingTo, [conversationId]: undefined } })),

    editMessage: async (m, text) => {
      const { data } = await api.patch<{ message: Message }>(`/messages/${m.id}`, { text });
      get().applyMessage(data.message, false);
    },

    deleteMessage: async (m) => {
      const { data } = await api.delete<{ message: Message }>(`/messages/${m.id}`);
      get().applyMessage(data.message, false);
    },

    toggleReaction: async (m, emoji) => {
      const mine = m.reactions.some((r) => r.emoji === emoji && r.userIds.includes(meId() ?? ""));
      const { data } = await api.request<{ message: Message }>({
        method: mine ? "delete" : "put",
        url: `/messages/${m.id}/reactions`,
        data: { emoji },
      });
      get().applyMessage(data.message, false);
    },

    applyMessage: (m, isNew) => {
      const id = m.conversationId;
      const state = get();
      const conversation = state.conversations[id];
      if (!conversation) {
        // A conversation we have not heard of yet (just created or just joined).
        void state.loadConversations().catch(() => {});
        return;
      }
      const mine = m.senderId === meId();
      const watching = state.activeId === id && isLooking();
      const cs = state.byConv[id];
      const alreadyHad = cs?.messages.some((x) => x.id === m.id) ?? false;

      if (m.seq >= conversation.lastSeq) {
        const fresh = isNew && m.seq > conversation.lastSeq;
        patchConversation(id, (c) => ({
          ...c,
          lastSeq: m.seq,
          rev: Math.max(c.rev, m.rev),
          lastMessageAt: fresh ? m.createdAt : c.lastMessageAt,
          lastMessage: {
            id: m.id, seq: m.seq, senderId: m.senderId, kind: m.kind, text: m.text,
            hasImage: m.image !== null, deleted: m.deleted, createdAt: m.createdAt,
          },
          unreadCount: fresh && !mine && !watching && m.kind === "user" && !alreadyHad && !silenced(m, conversation) ? c.unreadCount + 1 : c.unreadCount,
          myLastReadSeq: mine ? Math.max(c.myLastReadSeq, m.seq) : c.myLastReadSeq,
        }));
      }

      if (cs) {
        maxSeenRev.set(id, Math.max(maxSeenRev.get(id) ?? 0, m.rev));
        patchConv(id, (x) => ({
          ...x,
          messages: upsert(x.messages, m),
          pending: x.pending.filter((p) => p.id !== m.id),
          syncedRev: m.rev === x.syncedRev + 1 ? m.rev : x.syncedRev,
        }));
        // A rev was skipped: something changed that we were not told about. Fetch it.
        if (m.rev > (get().byConv[id]?.syncedRev ?? 0)) scheduleSync(id);
      }

      // Keep the open lane in step: the message may belong in it, or have just left it.
      const lane = get().lane;
      if (lane && lane.conversationId === id && lane.loaded) {
        const inLane = lane.messages.some((x) => x.id === m.id);
        if (m.topicId === lane.topicId) set({ lane: { ...lane, messages: upsert(lane.messages, m) } });
        else if (inLane) set({ lane: { ...lane, messages: lane.messages.filter((x) => x.id !== m.id) } });
      }

      if (m.senderId && isNew) {
        set((s) => {
          const t = s.typing[id];
          if (!t?.[m.senderId!]) return s;
          const { [m.senderId!]: _done, ...rest } = t;
          return { typing: { ...s.typing, [id]: rest } };
        });
      }
      if (watching && !mine && isNew) get().markRead(id);
    },

    syncConversation: async (id) => {
      const cs = get().byConv[id];
      if (!cs || syncing.has(id)) return;
      syncing.add(id);
      try {
        const { data } = await api.get<{ messages: Message[]; rev: number; reset: boolean }>(`/conversations/${id}/changes`, {
          params: { since: cs.syncedRev },
        });
        if (data.reset) {
          set((s) => ({ byConv: { ...s.byConv, [id]: { ...cs, messages: [], pending: s.byConv[id]?.pending ?? [] } } }));
          await loadLatest(id);
        } else {
          patchConv(id, (x) => {
            let messages = x.messages;
            const oldest = messages[0]?.seq ?? 0;
            // Changes to messages older than the loaded window are picked up when
            // that part of the history is paged in.
            for (const m of data.messages) if (m.seq >= oldest) messages = upsert(messages, m);
            const confirmed = new Set(data.messages.map((m) => m.id));
            return { ...x, messages, pending: x.pending.filter((p) => !confirmed.has(p.id)), syncedRev: Math.max(x.syncedRev, data.rev) };
          });
        }
      } catch {
        /* still offline; the next reconnect tries again */
      } finally {
        syncing.delete(id);
      }
    },

    /** Called on every (re)connect: refresh the list, then fetch what each open chat missed. */
    resync: async () => {
      await get().loadConversations().catch(() => {});
      const { byConv, conversations, activeId } = get();
      await Promise.all(Object.keys(byConv).filter((id) => conversations[id]).map((id) => get().syncConversation(id)));
      // Lanes may have been renamed, merged or removed while we were away: reload them.
      await Promise.all(Object.keys(get().topics).filter((id) => conversations[id]).map((id) => get().loadTopics(id).catch(() => {})));
      const openLane = get().lane;
      if (openLane) get().setView(openLane.conversationId, { mode: "lane", topicId: openLane.topicId });
      for (const [id, cs] of Object.entries(get().byConv)) {
        for (const p of cs?.pending ?? []) if (p.status === "failed") get().retry(id, p.id);
      }
      if (activeId && isLooking()) get().markRead(activeId);
      void get().loadInbox();
    },

    markRead: (id) => {
      const c = get().conversations[id];
      if (!c || !isLooking()) return;
      if (c.lastSeq <= c.myLastReadSeq && c.unreadCount === 0) return;
      const seq = c.lastSeq;
      patchConversation(id, (x) => ({ ...x, unreadCount: 0, myLastReadSeq: Math.max(x.myLastReadSeq, seq) }));
      set((s) => {
        const t = s.topics[id];
        if (!t || !Object.values(t).some((x) => x.unreadCount > 0)) return s;
        return { topics: { ...s.topics, [id]: Object.fromEntries(Object.entries(t).map(([k, x]) => [k, { ...x, unreadCount: 0 }])) } };
      });
      void api.post(`/conversations/${id}/read`, { seq }).catch(() => {});
    },

    applyRead: ({ conversationId, userId, lastReadSeq }) => {
      patchConversation(conversationId, (c) => {
        const members = c.members.map((m) => (m.id === userId ? { ...m, lastReadSeq: Math.max(m.lastReadSeq, lastReadSeq) } : m));
        if (userId !== meId()) return { ...c, members };
        // Read on another of my devices.
        return { ...c, members, myLastReadSeq: Math.max(c.myLastReadSeq, lastReadSeq), unreadCount: lastReadSeq >= c.lastSeq ? 0 : c.unreadCount };
      });
    },

    applyTyping: ({ conversationId, userId }) => {
      const until = Date.now() + TYPING_MS;
      set((s) => ({ typing: { ...s.typing, [conversationId]: { ...s.typing[conversationId], [userId]: until } } }));
      setTimeout(() => {
        set((s) => {
          const t = s.typing[conversationId];
          if (!t || (t[userId] ?? 0) > Date.now()) return s;
          const { [userId]: _done, ...rest } = t;
          return { typing: { ...s.typing, [conversationId]: rest } };
        });
      }, TYPING_MS + 50);
    },

    setPresence: (userId, online) =>
      set((s) => {
        if (online) return { online: { ...s.online, [userId]: true } };
        const { [userId]: _gone, ...rest } = s.online;
        return { online: rest };
      }),

    setOnline: (ids) => set({ online: Object.fromEntries(ids.map((id) => [id, true as const])) }),

    setConnected: (connected) => set({ connected }),

    reset: () => {
      maxSeenRev.clear();
      for (const t of syncTimers.values()) clearTimeout(t);
      syncTimers.clear();
      for (const t of recountTimers.values()) clearTimeout(t);
      recountTimers.clear();
      set({ ...initial });
    },
  };
});
