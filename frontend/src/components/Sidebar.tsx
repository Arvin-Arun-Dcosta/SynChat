import { MessageCircleQuestion, Search, SquarePen } from "lucide-react";
import { useMemo, useState } from "react";
import { conversationAvatar, conversationTitle, firstName, formatListTime, otherMember, previewText } from "../lib/format";
import { useAuthStore } from "../store/useAuthStore";
import { useChatStore } from "../store/useChatStore";
import type { Conversation } from "../types";
import Avatar from "./Avatar";
import NewChatDialog from "./NewChatDialog";
import InboxDialog from "./InboxDialog";
import SearchDialog from "./SearchDialog";
import { useConfigStore } from "../store/useConfigStore";
import { useSmart } from "../store/useSmartStore";

const Row = ({ c, meId }: { c: Conversation; meId: string }) => {
  const active = useChatStore((s) => s.activeId === c.id);
  const setActive = useChatStore((s) => s.setActive);
  const typing = useChatStore((s) => s.typing[c.id]);
  const peer = c.type === "dm" ? otherMember(c, meId) : undefined;
  const peerOnline = useChatStore((s) => (peer ? Boolean(s.online[peer.id]) : false));
  const title = conversationTitle(c, meId);
  const last = c.lastMessage;
  const typingIds = Object.keys(typing ?? {});

  let preview = "No messages yet";
  if (typingIds.length > 0) {
    preview = c.type === "dm" ? "typing…" : `${firstName(c.members.find((m) => m.id === typingIds[0]))} is typing…`;
  } else if (last) {
    const who =
      last.kind === "system" ? "" : last.senderId === meId ? "You: " : c.type === "group" ? `${firstName(c.members.find((m) => m.id === last.senderId))}: ` : "";
    preview = who + previewText(last);
  }

  return (
    <button
      data-testid="conversation-row"
      onClick={() => setActive(c.id)}
      className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-base-200 ${active ? "bg-base-200" : ""}`}
    >
      <Avatar name={title} src={conversationAvatar(c, meId)} seed={peer?.id ?? c.id} size={48} online={peerOnline} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-medium">{title}</span>
          {last && <span className="shrink-0 text-xs text-base-content/50">{formatListTime(last.createdAt)}</span>}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className={`truncate text-sm ${typingIds.length > 0 ? "text-primary" : c.unreadCount > 0 ? "text-base-content" : "text-base-content/60"}`}>
            {preview}
          </span>
          {c.unreadCount > 0 && (
            <span data-testid="unread-badge" className="badge badge-primary badge-sm shrink-0">
              {c.unreadCount > 99 ? "99+" : c.unreadCount}
            </span>
          )}
        </div>
      </div>
    </button>
  );
};

const Sidebar = () => {
  const meId = useAuthStore((s) => s.user!.id);
  const conversations = useChatStore((s) => s.conversations);
  const listLoaded = useChatStore((s) => s.listLoaded);
  const activeId = useChatStore((s) => s.activeId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchOn = useSmart("search");
  const inboxMine = useSmart("inbox");
  const aiConfigured = useConfigStore((s) => s.features.llm);
  const inboxOn = inboxMine && aiConfigured;
  const waiting = useChatStore((s) => s.inbox.length);
  const [inboxOpen, setInboxOpen] = useState(false);

  const sorted = useMemo(
    () => Object.values(conversations).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)),
    [conversations],
  );

  return (
    <aside className={`${activeId ? "hidden md:flex" : "flex"} h-full w-full shrink-0 flex-col border-r border-base-300 bg-base-100 md:w-80`}>
      <div className="flex items-center justify-between border-b border-base-300 px-4 py-3">
        <span className="text-lg font-semibold">Chats</span>
        <div className="flex items-center">
          {inboxOn && (
            <button className="btn btn-ghost btn-sm btn-circle relative" aria-label={`Questions waiting on you (${waiting})`} title="Questions waiting on you" onClick={() => setInboxOpen(true)}>
              <MessageCircleQuestion className="size-5" />
              {waiting > 0 && (
                <span className="badge badge-primary badge-xs absolute -right-0.5 -top-0.5" data-testid="inbox-count">
                  {waiting}
                </span>
              )}
            </button>
          )}
          {searchOn && (
            <button className="btn btn-ghost btn-sm btn-circle" aria-label="Search messages" title="Search messages" onClick={() => setSearchOpen(true)}>
              <Search className="size-5" />
            </button>
          )}
          <button className="btn btn-ghost btn-sm btn-circle" aria-label="New chat" title="New chat" onClick={() => setDialogOpen(true)}>
            <SquarePen className="size-5" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!listLoaded &&
          Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2.5">
              <div className="skeleton size-12 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <div className="skeleton h-4 w-32" />
                <div className="skeleton h-3 w-44" />
              </div>
            </div>
          ))}
        {listLoaded && sorted.length === 0 && (
          <div className="p-6 text-center text-sm text-base-content/60">
            No chats yet.
            <button className="btn btn-primary btn-sm mt-3 w-full" onClick={() => setDialogOpen(true)}>
              Start a chat
            </button>
          </div>
        )}
        {sorted.map((c) => (
          <Row key={c.id} c={c} meId={meId} />
        ))}
      </div>

      {dialogOpen && <NewChatDialog onClose={() => setDialogOpen(false)} />}
      {searchOpen && searchOn && <SearchDialog onClose={() => setSearchOpen(false)} />}
      {inboxOpen && inboxOn && <InboxDialog onClose={() => setInboxOpen(false)} />}
    </aside>
  );
};
export default Sidebar;
