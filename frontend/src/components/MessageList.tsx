import { ArrowDown, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { isSameDay } from "../lib/format";
import { itemId, itemSender, itemTime, type RowItem } from "../lib/rows";
import { useAuthStore } from "../store/useAuthStore";
import { useChatStore } from "../store/useChatStore";
import type { Conversation, Member, Message, PendingMessage, Topic } from "../types";
import MessageRow from "./MessageRow";

const BASE_INDEX = 1_000_000;
const RUN_GAP_MS = 5 * 60 * 1000;

/**
 * Virtuoso keeps the scroll position steady when rows are added above, provided it
 * is told how many: firstItemIndex must drop by the number of rows prepended.
 */
function useFirstItemIndex(ids: string[]): number {
  const [anchor, setAnchor] = useState({ firstId: ids[0], index: BASE_INDEX });
  if (ids[0] === anchor.firstId) return anchor.index;
  const shift = anchor.firstId ? ids.indexOf(anchor.firstId) : -1;
  const next = { firstId: ids[0], index: shift > 0 ? anchor.index - shift : BASE_INDEX };
  setAnchor(next);
  return next.index;
}

const Header = ({ context }: { context?: { loadingOlder: boolean; hasMore: boolean; startText: string } }) => (
  <div className="flex h-10 items-center justify-center text-xs text-base-content/50">
    {context?.loadingOlder ? <span className="loading loading-spinner loading-sm" /> : context?.hasMore ? null : context?.startText}
  </div>
);
const Footer = () => <div className="h-3" />;

interface Props {
  conversation: Conversation;
  /** The messages to show: the whole chat, or one lane of it. */
  state: { messages: Message[]; pending: PendingMessage[]; hasMore: boolean; loadingOlder: boolean };
  onLoadOlder: () => void;
  /** The conversation's topics, when lanes are on. In the mixed view each message is labelled. */
  topics?: Record<string, Topic>;
  /** True when showing a single lane: every message is in the same topic, so no labels. */
  inLane?: boolean;
  onOpenTopic?: (topicId: string) => void;
  onMove?: (message: Message) => void;
}

const noop = () => {};

const MessageList = ({ conversation, state, onLoadOlder, topics, inLane = false, onOpenTopic = noop, onMove }: Props) => {
  const meId = useAuthStore((s) => s.user!.id);
  const markRead = useChatStore((s) => s.markRead);
  const virtuoso = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const items = useMemo<RowItem[]>(
    () => [
      ...state.messages.map((message): RowItem => ({ kind: "message", message })),
      ...state.pending.map((pending): RowItem => ({ kind: "pending", pending })),
    ],
    [state.messages, state.pending],
  );
  const ids = useMemo(() => items.map(itemId), [items]);
  const firstItemIndex = useFirstItemIndex(ids);
  const members = useMemo(() => new Map<string, Member>(conversation.members.map((m) => [m.id, m])), [conversation.members]);
  // Read positions of everyone else, highest first, to count readers of a message quickly.
  const otherReads = useMemo(
    () => conversation.members.filter((m) => m.id !== meId).map((m) => m.lastReadSeq).sort((a, b) => b - a),
    [conversation.members, meId],
  );
  const isGroup = conversation.type === "group";
  const canModerate = isGroup && conversation.myRole === "admin";

  const jumpTo = useCallback(
    (messageId: string) => {
      const at = ids.indexOf(messageId);
      if (at === -1) return; // older than what is loaded
      virtuoso.current?.scrollToIndex({ index: at, align: "center", behavior: "smooth" });
      setHighlighted(messageId);
      setTimeout(() => setHighlighted((h) => (h === messageId ? null : h)), 1600);
    },
    [ids],
  );

  // A search result was opened: scroll to it (the store flashes it for a moment).
  const reveal = useChatStore((s) => s.reveal);
  const revealId = reveal && reveal.conversationId === conversation.id && !inLane ? reveal.messageId : null;
  useEffect(() => {
    if (!revealId) return;
    const at = ids.indexOf(revealId);
    if (at !== -1) virtuoso.current?.scrollToIndex({ index: at, align: "center" });
    // Only when a new reveal arrives, not whenever the list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);

  const renderItem = useCallback(
    (index: number, item: RowItem) => {
      const prev = items[index - firstItemIndex - 1];
      const senderId = itemSender(item, meId);
      const startsDay = !prev || !isSameDay(itemTime(prev), itemTime(item));
      const startsRun =
        startsDay ||
        !prev ||
        itemSender(prev, meId) !== senderId ||
        (prev.kind === "message" && prev.message.kind === "system") ||
        new Date(itemTime(item)).getTime() - new Date(itemTime(prev)).getTime() > RUN_GAP_MS;
      const seq = item.kind === "message" ? item.message.seq : Infinity;
      let readBy = 0;
      while (readBy < otherReads.length && otherReads[readBy]! >= seq) readBy++;
      return (
        <MessageRow
          item={item}
          meId={meId}
          isGroup={isGroup}
          canModerate={canModerate}
          members={members}
          startsRun={startsRun}
          startsDay={startsDay}
          readBy={readBy}
          others={otherReads.length}
          highlighted={highlighted === itemId(item) || revealId === itemId(item)}
          showTopic={Boolean(topics) && !inLane && item.kind === "message"}
          topic={item.kind === "message" && item.message.topicId ? topics?.[item.message.topicId] : undefined}
          onOpenTopic={onOpenTopic}
          onMove={topics ? onMove : undefined}
          onJumpTo={jumpTo}
          onOpenImage={setLightbox}
        />
      );
    },
    [items, firstItemIndex, meId, isGroup, canModerate, members, otherReads, highlighted, revealId, jumpTo, topics, inLane, onOpenTopic, onMove],
  );

  return (
    <div className="relative min-h-0 flex-1" data-testid="message-list">
      <Virtuoso
        ref={virtuoso}
        className="h-full"
        data={items}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={Math.max(0, items.length - 1)}
        computeItemKey={(_, item) => itemId(item)}
        itemContent={renderItem}
        context={{ loadingOlder: state.loadingOlder, hasMore: state.hasMore, startText: inLane ? "Start of this topic" : "Start of the conversation" }}
        components={{ Header, Footer }}
        startReached={onLoadOlder}
        // Stay pinned to the newest message unless the reader has scrolled up.
        followOutput={(isAtBottom) => (isAtBottom ? "auto" : false)}
        atBottomThreshold={80}
        atBottomStateChange={(bottom) => {
          setAtBottom(bottom);
          if (bottom) markRead(conversation.id);
        }}
        increaseViewportBy={{ top: 600, bottom: 300 }}
      />
      {!atBottom && (
        <button
          className="btn btn-circle btn-sm absolute bottom-3 right-4 shadow-md"
          aria-label="Jump to latest"
          onClick={() => virtuoso.current?.scrollToIndex({ index: "LAST", behavior: "smooth" })}
        >
          <ArrowDown className="size-4" />
        </button>
      )}
      {lightbox && (
        <dialog className="modal modal-open" aria-label="Image" onClick={() => setLightbox(null)}>
          <button className="btn btn-circle btn-sm absolute right-4 top-4" aria-label="Close image">
            <X className="size-4" />
          </button>
          <img src={lightbox} alt="Shared image, full size" className="max-h-[90vh] max-w-[92vw] rounded-lg object-contain" />
        </dialog>
      )}
    </div>
  );
};
export default MessageList;
