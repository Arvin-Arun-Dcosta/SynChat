import { ArrowLeft, Bell, BellOff, GitMerge, Pencil } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { errorMessage } from "../lib/api";
import { sortTopics, topicColor } from "../lib/topics";
import { useAuthStore } from "../store/useAuthStore";
import { useChatStore, type View } from "../store/useChatStore";
import { useAi, useSmart } from "../store/useSmartStore";
import type { Conversation, Message, Topic } from "../types";
import ChatHeader from "./ChatHeader";
import GroupInfoPanel from "./GroupInfoPanel";
import MessageInput from "./MessageInput";
import MessageList from "./MessageList";
import TopicPickerDialog from "./TopicPickerDialog";
import TopicStatus from "./TopicStatus";
import TopicsPanel from "./TopicsPanel";

const Skeleton = () => (
  <div className="min-h-0 flex-1 space-y-4 overflow-hidden p-4">
    {Array.from({ length: 6 }, (_, i) => (
      <div key={i} className={`flex ${i % 2 ? "justify-end" : ""}`}>
        <div className="skeleton h-12 w-52 rounded-2xl" />
      </div>
    ))}
  </div>
);

const CHAT: View = { mode: "chat" };
const NO_PENDING: never[] = [];

const ChatPane = ({ conversation }: { conversation: Conversation }) => {
  const id = conversation.id;
  const meId = useAuthStore((s) => s.user!.id);
  const state = useChatStore((s) => s.byConv[id]);
  const topicMap = useChatStore((s) => s.topics[id]);
  const storedView = useChatStore((s) => s.view[id]) ?? CHAT;
  const lane = useChatStore((s) => s.lane);
  const setView = useChatStore((s) => s.setView);
  const loadTopics = useChatStore((s) => s.loadTopics);
  const loadOlder = useChatStore((s) => s.loadOlder);
  const loadOlderLane = useChatStore((s) => s.loadOlderLane);
  const moveMessage = useChatStore((s) => s.moveMessage);
  const mergeTopic = useChatStore((s) => s.mergeTopic);
  const renameTopic = useChatStore((s) => s.renameTopic);
  // Lanes exist in groups, for people who have not switched them off.
  const lanesOn = useSmart("lanes") && conversation.type === "group";
  const muteOn = useSmart("topicMute");
  const showStatus = useAi("status", conversation);
  const showCatchUp = useAi("catchUp", conversation);
  const awaySince = useChatStore((s) => s.awaySince[id]);
  const setTopicMuted = useChatStore((s) => s.setTopicMuted);
  const toggleMute = (t: Topic) => void setTopicMuted(id, t.id, !t.muted).catch((err) => toast.error(errorMessage(err)));
  const view = lanesOn ? storedView : CHAT;

  const [infoFor, setInfoFor] = useState<string | null>(null);
  const [moving, setMoving] = useState<Message | null>(null);
  const [merging, setMerging] = useState<Topic | null>(null);
  const infoOpen = infoFor === id && conversation.type === "group";

  useEffect(() => {
    if (lanesOn) void loadTopics(id).catch(() => {});
  }, [lanesOn, id, loadTopics]);

  const topics = useMemo(() => sortTopics(topicMap), [topicMap]);
  const openTopic = useCallback((topicId: string) => setView(id, { mode: "lane", topicId }), [id, setView]);
  const openMove = useCallback((m: Message) => setMoving(m), []);
  const loadOlderHere = useCallback(() => void loadOlder(id), [id, loadOlder]);
  const loadOlderInLane = useCallback(() => void loadOlderLane(), [loadOlderLane]);

  const rename = (t: Topic) => {
    const title = window.prompt("Rename topic", t.title)?.trim();
    if (title && title !== t.title) void renameTopic(t.id, title).catch((err) => toast.error(errorMessage(err)));
  };
  const report = async (work: Promise<void>, done: string) => {
    try {
      await work;
      toast.success(done);
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };

  const laneTopic = view.mode === "lane" ? topicMap?.[view.topicId] : undefined;
  const laneReady = view.mode === "lane" && lane?.conversationId === id && lane.topicId === view.topicId && lane.loaded;
  const lanePending = useMemo(
    () => (view.mode === "lane" ? (state?.pending.filter((p) => p.topicId === view.topicId) ?? NO_PENDING) : NO_PENDING),
    [state?.pending, view],
  );

  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col bg-base-100">
      <ChatHeader
        conversation={conversation}
        onOpenInfo={conversation.type === "group" ? () => setInfoFor(id) : undefined}
        lanes={lanesOn ? { showingTopics: view.mode !== "chat", count: topics.length, onToggle: (on) => setView(id, on ? { mode: "topics" } : CHAT) } : undefined}
      />

      {view.mode === "lane" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-base-300 bg-base-200/60 px-3 py-1.5" data-testid="lane-header">
          <button className="btn btn-ghost btn-xs gap-1" onClick={() => setView(id, { mode: "topics" })}>
            <ArrowLeft className="size-3.5" /> Topics
          </button>
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: topicColor(view.topicId) }} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium" data-testid="lane-title">
            {laneTopic?.title ?? "Topic"}
          </span>
          {laneTopic && (
            <>
              {showStatus && <TopicStatus topic={laneTopic} editable />}
              {muteOn && (
                <button
                  className="btn btn-ghost btn-xs btn-circle"
                  aria-label={laneTopic.muted ? "Unmute this topic" : "Mute this topic"}
                  aria-pressed={laneTopic.muted}
                  title={laneTopic.muted ? "Muted. Click to unmute" : "Mute this topic"}
                  onClick={() => toggleMute(laneTopic)}
                >
                  {laneTopic.muted ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
                </button>
              )}
              <button className="btn btn-ghost btn-xs btn-circle" aria-label="Rename this topic" title="Rename" onClick={() => rename(laneTopic)}>
                <Pencil className="size-3.5" />
              </button>
              <button className="btn btn-ghost btn-xs btn-circle" aria-label="Merge this topic into another" title="Merge into another topic" onClick={() => setMerging(laneTopic)}>
                <GitMerge className="size-3.5" />
              </button>
            </>
          )}
        </div>
      )}

      {view.mode === "topics" && (
        <TopicsPanel conversation={conversation} topics={topicMap ? topics : undefined} meId={meId} onOpen={(t) => openTopic(t.id)} onRename={rename} onMerge={setMerging} onToggleMute={muteOn ? toggleMute : undefined} showCatchUp={showCatchUp} showStatus={showStatus} awaySince={awaySince} />
      )}
      {view.mode === "lane" && showStatus && laneTopic?.status === "decided" && laneTopic.outcome && (
        <div className="flex shrink-0 items-start gap-2 border-b border-success/40 bg-success/10 px-4 py-2 text-sm" data-testid="lane-outcome">
          <span className="font-medium">Decided:</span>
          {/* Written by the AI digest or by a member; plain text either way. */}
          <span className="min-w-0 flex-1">{laneTopic.outcome}</span>
        </div>
      )}
      {view.mode === "lane" &&
        (laneReady && lane ? (
          <MessageList
            key={`lane-${view.topicId}`}
            conversation={conversation}
            state={{ messages: lane.messages, pending: lanePending, hasMore: lane.hasMore, loadingOlder: lane.loadingOlder }}
            onLoadOlder={loadOlderInLane}
            topics={topicMap}
            inLane
            onMove={openMove}
          />
        ) : (
          <Skeleton />
        ))}
      {/* Keyed so each conversation gets a fresh list that opens at its newest message. */}
      {view.mode === "chat" &&
        (state ? (
          <MessageList
            key={`list-${id}`}
            conversation={conversation}
            state={state}
            onLoadOlder={loadOlderHere}
            topics={lanesOn ? topicMap : undefined}
            onOpenTopic={openTopic}
            onMove={lanesOn ? openMove : undefined}
          />
        ) : (
          <Skeleton />
        ))}

      {view.mode !== "topics" && <MessageInput key={`input-${id}`} conversation={conversation} lane={view.mode === "lane" ? laneTopic : undefined} />}

      {infoOpen && <GroupInfoPanel conversation={conversation} onClose={() => setInfoFor(null)} />}
      {moving && (
        <TopicPickerDialog
          title="Move to topic"
          hint="Put this message where it belongs. Everyone in the group sees the change."
          topics={topics}
          excludeId={moving.topicId}
          allowNew
          confirmLabel="Move"
          onPick={(target) => report(moveMessage(moving, target), "Message moved")}
          onClose={() => setMoving(null)}
        />
      )}
      {merging && (
        <TopicPickerDialog
          title={`Merge “${merging.title}” into…`}
          hint="All of its messages move to the topic you pick. Everyone in the group sees the change."
          topics={topics}
          excludeId={merging.id}
          confirmLabel="Merge"
          onPick={(target) => ("topicId" in target ? report(mergeTopic(merging.id, target.topicId), "Topics merged") : Promise.resolve())}
          onClose={() => setMerging(null)}
        />
      )}
    </section>
  );
};
export default ChatPane;
