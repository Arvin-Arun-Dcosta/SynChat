import { ArrowLeft, Info } from "lucide-react";
import { conversationAvatar, conversationTitle, firstName, joinNames, otherMember } from "../lib/format";
import { useAuthStore } from "../store/useAuthStore";
import { useChatStore } from "../store/useChatStore";
import type { Conversation } from "../types";
import Avatar from "./Avatar";

interface Props {
  conversation: Conversation;
  onOpenInfo?: () => void;
  /** Present in groups with lanes on: the switch between the mixed chat and its topics. */
  lanes?: { showingTopics: boolean; count: number; onToggle: (showTopics: boolean) => void };
}

const ChatHeader = ({ conversation: c, onOpenInfo, lanes }: Props) => {
  const meId = useAuthStore((s) => s.user!.id);
  const setActive = useChatStore((s) => s.setActive);
  const typing = useChatStore((s) => s.typing[c.id]);
  const peer = c.type === "dm" ? otherMember(c, meId) : undefined;
  const peerOnline = useChatStore((s) => (peer ? Boolean(s.online[peer.id]) : false));
  const title = conversationTitle(c, meId);

  const typingNames = Object.keys(typing ?? {}).map((id) => firstName(c.members.find((m) => m.id === id)));
  let subtitle: string;
  if (typingNames.length > 0) {
    subtitle = c.type === "dm" ? "typing…" : `${joinNames(typingNames)} ${typingNames.length === 1 ? "is" : "are"} typing…`;
  } else if (c.type === "dm") {
    subtitle = peerOnline ? "Online" : "Offline";
  } else {
    subtitle = `${c.members.length} ${c.members.length === 1 ? "member" : "members"}`;
  }

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-base-300 bg-base-100 px-3 py-2">
      <button className="btn btn-ghost btn-sm btn-circle md:hidden" aria-label="Back to chats" onClick={() => setActive(null)}>
        <ArrowLeft className="size-5" />
      </button>
      <Avatar name={title} src={conversationAvatar(c, meId)} seed={peer?.id ?? c.id} online={peerOnline} />
      <div className="min-w-0 flex-1">
        <h2 className="truncate font-medium leading-tight" data-testid="chat-title">
          {title}
        </h2>
        <p className={`truncate text-sm ${typingNames.length > 0 ? "text-primary" : "text-base-content/60"}`} data-testid="chat-subtitle">
          {subtitle}
        </p>
      </div>
      {lanes && (
        <div className="join" role="group" aria-label="View">
          <button
            className={`btn join-item btn-sm ${lanes.showingTopics ? "" : "btn-active"}`}
            aria-pressed={!lanes.showingTopics}
            onClick={() => lanes.onToggle(false)}
          >
            Chat
          </button>
          <button
            className={`btn join-item btn-sm ${lanes.showingTopics ? "btn-active" : ""}`}
            aria-pressed={lanes.showingTopics}
            data-testid="topics-switch"
            onClick={() => lanes.onToggle(true)}
          >
            Topics{lanes.count > 0 ? ` · ${lanes.count}` : ""}
          </button>
        </div>
      )}
      {onOpenInfo && (
        <button className="btn btn-ghost btn-sm btn-circle" aria-label="Group info" title="Group info" onClick={onOpenInfo}>
          <Info className="size-5" />
        </button>
      )}
    </div>
  );
};
export default ChatHeader;
