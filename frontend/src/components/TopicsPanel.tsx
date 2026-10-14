import { Bell, BellOff, GitMerge, Pencil, Sparkles } from "lucide-react";
import { useState } from "react";
import toast from "react-hot-toast";
import { errorMessage } from "../lib/api";
import { useChatStore } from "../store/useChatStore";
import TopicStatus from "./TopicStatus";
import { firstName, formatListTime } from "../lib/format";
import { topicColor } from "../lib/topics";
import type { Conversation, Topic } from "../types";
import Avatar from "./Avatar";

interface Props {
  conversation: Conversation;
  topics: Topic[] | undefined;
  meId: string;
  onOpen: (topic: Topic) => void;
  onRename: (topic: Topic) => void;
  onMerge: (topic: Topic) => void;
  /** Absent when the member has switched topic mute off. */
  onToggleMute?: (topic: Topic) => void;
  /** Which AI features to show (each needs the server, the group's admin and me to allow it). */
  showCatchUp: boolean;
  showStatus: boolean;
  /** How far I had read when I opened this chat; topics active since then are what I missed. */
  awaySince: number | undefined;
}

/** "What did I miss?" for a topic with unread messages: the digest's two-line recap. */
const CatchUp = ({ topic }: { topic: Topic }) => {
  const refreshDigest = useChatStore((s) => s.refreshDigest);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const ready = topic.recap && (!topic.digestStale || asked);

  const fetchNow = async () => {
    setBusy(true);
    try {
      await refreshDigest(topic.id);
      setAsked(true);
    } catch (err) {
      toast.error(errorMessage(err, "Could not get a summary"));
    } finally {
      setBusy(false);
    }
  };

  if (ready) {
    return (
      <p className="mt-1.5 flex gap-1.5 whitespace-pre-line rounded-lg bg-base-200 px-2 py-1.5 text-sm" data-testid="catch-up">
        <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" aria-label="AI summary" />
        {/* Model-written text, rendered as plain text. */}
        <span>{topic.recap}</span>
      </p>
    );
  }
  return (
    <button className="btn btn-xs mt-1.5 gap-1" disabled={busy} onClick={() => void fetchNow()} data-testid="catch-up-button">
      {busy ? <span className="loading loading-spinner loading-xs" /> : <Sparkles className="size-3" />} Catch up
    </button>
  );
};

/** The Topics view: every lane of the group, most recently active first. */
const TopicsPanel = ({ conversation, topics, meId, onOpen, onRename, onMerge, onToggleMute, showCatchUp, showStatus, awaySince }: Props) => {
  // A topic I missed something in: unread now, or active since I was last here.
  const missed = (t: Topic) => t.unreadCount > 0 || (awaySince !== undefined && t.lastSeq > awaySince && t.lastMessage?.senderId !== meId);
  if (!topics) {
    return (
      <div className="min-h-0 flex-1 space-y-2 p-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (topics.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center text-sm text-base-content/60">
        No topics yet. As people talk, SynChat sorts the messages into topics here.
      </div>
    );
  }
  const name = (id: string | null) => (id === meId ? "You" : firstName(conversation.members.find((m) => m.id === id)));

  return (
    <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-testid="topics-panel">
      {topics.map((t) => (
        <li
          key={t.id}
          data-testid="topic-row"
          data-topic-id={t.id}
          data-muted={t.muted && Boolean(onToggleMute)}
          className={`group/topic flex flex-wrap items-stretch rounded-xl border border-base-300 bg-base-100 hover:bg-base-200 ${t.muted && onToggleMute ? "opacity-60" : ""}`}
        >
          <button className="flex min-w-0 flex-1 items-center gap-3 p-3 text-left" onClick={() => onOpen(t)}>
            <span className="h-10 w-1.5 shrink-0 rounded-full" style={{ background: topicColor(t.id) }} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium" data-testid="topic-title">
                    {t.title}
                  </span>
                  {showStatus && <TopicStatus topic={t} />}
                </span>
                <span className="shrink-0 text-xs text-base-content/50">{formatListTime(t.lastMessageAt)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm text-base-content/60">
                  {t.lastMessage ? `${name(t.lastMessage.senderId)}: ${t.lastMessage.text ?? (t.lastMessage.hasImage ? "Photo" : "")}` : ""}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="flex -space-x-2">
                    {t.participants.slice(0, 3).map((id) => {
                      const m = conversation.members.find((x) => x.id === id);
                      return m ? <Avatar key={id} name={m.fullName} src={m.avatarUrl} seed={m.id} size={20} /> : null;
                    })}
                  </span>
                  <span className="text-xs text-base-content/50" data-testid="topic-count">
                    {t.messageCount}
                  </span>
                  {t.unreadCount > 0 && (
                    <span className={`badge badge-sm ${t.muted && onToggleMute ? "badge-ghost" : "badge-primary"}`} data-testid="topic-unread">
                      {t.unreadCount}
                    </span>
                  )}
                </span>
              </div>
            </div>
          </button>
          <div className="flex items-center pr-2 opacity-60 group-hover/topic:opacity-100">
            {onToggleMute && (
              <button
                className="btn btn-ghost btn-xs btn-circle"
                aria-label={t.muted ? `Unmute topic ${t.title}` : `Mute topic ${t.title}`}
                aria-pressed={t.muted}
                title={t.muted ? "Muted: no notifications or unread count, except when you are mentioned. Click to unmute" : "Mute this topic"}
                onClick={() => onToggleMute(t)}
              >
                {t.muted ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
              </button>
            )}
            <button className="btn btn-ghost btn-xs btn-circle" aria-label={`Rename topic ${t.title}`} title="Rename" onClick={() => onRename(t)}>
              <Pencil className="size-3.5" />
            </button>
            <button className="btn btn-ghost btn-xs btn-circle" aria-label={`Merge topic ${t.title} into another`} title="Merge into another topic" onClick={() => onMerge(t)}>
              <GitMerge className="size-3.5" />
            </button>
          </div>
          {((showStatus && t.status === "decided" && t.outcome) || (showCatchUp && missed(t))) && (
            <div className="w-full px-3 pb-3 pl-[1.875rem]">
              {showStatus && t.status === "decided" && t.outcome && (
                <p className="text-sm" data-testid="topic-outcome">
                  <span className="font-medium">Decided:</span> {t.outcome}
                </p>
              )}
              {showCatchUp && missed(t) && <CatchUp topic={t} />}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
};
export default TopicsPanel;
