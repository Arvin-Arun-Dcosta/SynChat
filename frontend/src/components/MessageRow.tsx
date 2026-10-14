import { AlertCircle, Ban, Check, CheckCheck, Clock, MoreHorizontal, Pencil, Reply, Shuffle, SmilePlus, Trash2 } from "lucide-react";
import { memo, useState } from "react";
import toast from "react-hot-toast";
import { errorMessage } from "../lib/api";
import { firstName, formatDay, formatTime, previewText } from "../lib/format";
import { itemSender, itemTime, type RowItem } from "../lib/rows";
import { useChatStore } from "../store/useChatStore";
import type { Member, Message, ReplyPreview, Topic } from "../types";
import Avatar from "./Avatar";
import MessageText from "./MessageText";
import TopicChip from "./TopicChip";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

interface Props {
  item: RowItem;
  meId: string;
  isGroup: boolean;
  /** I am an admin of this group (may delete other people's messages). */
  canModerate: boolean;
  members: Map<string, Member>;
  /** First message of a run by the same person: show who is talking. */
  startsRun: boolean;
  /** First message of a calendar day: show the date above it. */
  startsDay: boolean;
  /** For my own messages: how many of the other members have read it. */
  readBy: number;
  others: number;
  highlighted: boolean;
  /** Show which topic lane each message is in (the mixed view of a group). */
  showTopic: boolean;
  topic: Topic | undefined;
  onOpenTopic: (topicId: string) => void;
  /** Present when messages can be moved between topics. */
  onMove?: (message: Message) => void;
  onJumpTo: (messageId: string) => void;
  onOpenImage: (url: string) => void;
}

const Quote = ({ reply, members, meId, mine, onClick }: { reply: ReplyPreview; members: Map<string, Member>; meId: string; mine: boolean; onClick: () => void }) => (
  <button
    type="button"
    data-testid="quote"
    onClick={onClick}
    className={`mb-1 block w-full rounded-lg border-l-4 px-2 py-1 text-left text-sm ${mine ? "border-primary-content/60 bg-primary-content/15" : "border-primary bg-base-300/60"}`}
  >
    <span className="block text-xs font-semibold">{reply.senderId === meId ? "You" : firstName(members.get(reply.senderId ?? ""))}</span>
    <span className="line-clamp-2 opacity-80">{previewText(reply)}</span>
  </button>
);

const Actions = ({ message, mine, canDelete, onMove }: { message: Message; mine: boolean; canDelete: boolean; onMove?: (m: Message) => void }) => {
  const [menu, setMenu] = useState<"react" | "more" | null>(null);
  const toggleReaction = useChatStore((s) => s.toggleReaction);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const setReplyingTo = useChatStore((s) => s.setReplyingTo);
  const setEditing = useChatStore((s) => s.setEditing);
  const run = (p: Promise<unknown>) => void p.catch((err) => toast.error(errorMessage(err)));

  return (
    <div
      className={`relative flex shrink-0 items-center self-center transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100 ${menu ? "opacity-100" : "opacity-0"}`}
    >
      <button className="btn btn-ghost btn-xs btn-circle" aria-label="React" title="React" onClick={() => setMenu(menu === "react" ? null : "react")}>
        <SmilePlus className="size-4" />
      </button>
      <button className="btn btn-ghost btn-xs btn-circle" aria-label="Reply" title="Reply" onClick={() => setReplyingTo(message.conversationId, message)}>
        <Reply className="size-4" />
      </button>
      {(mine || canDelete || onMove) && (
        <button className="btn btn-ghost btn-xs btn-circle" aria-label="More" title="More" onClick={() => setMenu(menu === "more" ? null : "more")}>
          <MoreHorizontal className="size-4" />
        </button>
      )}
      {menu && <button className="fixed inset-0 z-10 cursor-default" aria-label="Close menu" onClick={() => setMenu(null)} />}
      {menu === "react" && (
        <div className={`absolute bottom-full z-20 mb-1 flex gap-0.5 rounded-full border border-base-300 bg-base-100 p-1 shadow-lg ${mine ? "right-0" : "left-0"}`}>
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              className="btn btn-ghost btn-sm btn-circle text-lg"
              aria-label={`React with ${emoji}`}
              onClick={() => {
                setMenu(null);
                run(toggleReaction(message, emoji));
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {menu === "more" && (
        <ul className={`menu menu-sm absolute bottom-full z-20 mb-1 w-44 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg ${mine ? "right-0" : "left-0"}`}>
          {onMove && (
            <li>
              <button
                onClick={() => {
                  setMenu(null);
                  onMove(message);
                }}
              >
                <Shuffle className="size-4" /> Move to topic…
              </button>
            </li>
          )}
          {mine && message.text !== null && (
            <li>
              <button
                onClick={() => {
                  setMenu(null);
                  setEditing(message.conversationId, message);
                }}
              >
                <Pencil className="size-4" /> Edit
              </button>
            </li>
          )}
          {(mine || canDelete) && (
            <li>
              <button
                className="text-error"
                onClick={() => {
                  setMenu(null);
                  if (window.confirm("Delete this message for everyone?")) run(deleteMessage(message));
                }}
              >
                <Trash2 className="size-4" /> Delete
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
};

const MessageRow = ({ item, meId, isGroup, canModerate, members, startsRun, startsDay, readBy, others, highlighted, showTopic, topic, onOpenTopic, onMove, onJumpTo, onOpenImage }: Props) => {
  const retry = useChatStore((s) => s.retry);
  const discard = useChatStore((s) => s.discard);
  const toggleReaction = useChatStore((s) => s.toggleReaction);

  const daySeparator = startsDay && (
    <div className="my-3 flex justify-center">
      <span className="rounded-full bg-base-200 px-3 py-0.5 text-xs text-base-content/60">{formatDay(itemTime(item))}</span>
    </div>
  );

  if (item.kind === "message" && item.message.kind === "system") {
    return (
      <div className="px-4">
        {daySeparator}
        <p className="my-2 text-center text-xs text-base-content/60" data-testid="system-message">
          {item.message.text}
        </p>
      </div>
    );
  }

  const senderId = itemSender(item, meId);
  const sender = senderId ? members.get(senderId) : undefined;
  const mine = senderId === meId;
  const message = item.kind === "message" ? item.message : null;
  const pending = item.kind === "pending" ? item.pending : null;
  const text = message ? message.text : pending!.text;
  const reply = message ? message.replyTo : pending!.replyTo;
  const image = message?.image ?? (pending?.image ? { url: pending.image.previewUrl, width: pending.image.width, height: pending.image.height } : null);
  const deleted = message?.deleted ?? false;
  const tone = mine ? "text-primary-content/70" : "text-base-content/50";

  return (
    <div className={`px-3 sm:px-4 ${highlighted ? "bg-primary/10 transition-colors duration-700" : ""}`}>
      {daySeparator}
      <div
        data-testid="message"
        data-mine={mine}
        data-status={pending ? pending.status : "sent"}
        className={`group/msg flex items-end gap-2 ${mine ? "flex-row-reverse" : ""} ${startsRun ? "mt-3" : "mt-0.5"}`}
      >
        {!mine && isGroup && (
          <div className="w-8 shrink-0">{startsRun && <Avatar name={sender?.fullName ?? "?"} src={sender?.avatarUrl} seed={sender?.id} size={32} />}</div>
        )}
        <div className={`flex min-w-0 max-w-[80%] flex-col sm:max-w-[70%] ${mine ? "items-end" : "items-start"}`}>
          {!mine && isGroup && startsRun && <span className="mb-0.5 ml-1 text-xs font-medium text-base-content/70">{sender?.fullName ?? "Former member"}</span>}
          <div className={`max-w-full rounded-2xl px-3 py-1.5 ${mine ? "bg-primary text-primary-content" : "bg-base-200"} ${pending ? "opacity-80" : ""}`}>
            {deleted ? (
              <p className="flex items-center gap-1.5 text-sm italic opacity-70">
                <Ban className="size-3.5" /> Message deleted
              </p>
            ) : (
              <>
                {reply && <Quote reply={reply} members={members} meId={meId} mine={mine} onClick={() => onJumpTo(reply.id)} />}
                {image && (
                  <button type="button" className="mb-1 block" onClick={() => onOpenImage(image.url)} aria-label="Open image">
                    <img
                      src={image.url}
                      alt="Shared image"
                      loading="lazy"
                      width={image.width ?? undefined}
                      height={image.height ?? undefined}
                      className="max-h-72 w-auto max-w-full rounded-lg object-contain"
                      // Reserve the space before the image loads so the list does not jump.
                      style={image.width && image.height ? { aspectRatio: `${image.width} / ${image.height}` } : undefined}
                    />
                  </button>
                )}
                {text && <MessageText text={text} mentions={message?.mentions ?? []} members={members} meId={meId} />}
              </>
            )}
            <div className={`mt-0.5 flex items-center justify-end gap-1 text-[10px] ${tone}`}>
              {showTopic && !deleted && (
                <TopicChip topic={topic} pending={!message?.topicId} onClick={() => topic && onOpenTopic(topic.id)} className="mr-auto pr-2" />
              )}
              {message?.editedAt && !deleted && <span>edited</span>}
              <time>{formatTime(itemTime(item))}</time>
              {pending?.status === "sending" && <Clock className="size-3" aria-label="Sending" />}
              {mine && message && !deleted && others > 0 && (
                <span data-testid="receipt" data-read={readBy >= others} title={isGroup ? `Read by ${readBy} of ${others}` : readBy ? "Read" : "Delivered"}>
                  {readBy >= others ? <CheckCheck className="size-3.5 text-info-content" strokeWidth={3} /> : <Check className="size-3.5" />}
                </span>
              )}
            </div>
          </div>
          {message && message.reactions.length > 0 && (
            <div className={`mt-1 flex flex-wrap gap-1 ${mine ? "justify-end" : ""}`}>
              {message.reactions.map((r) => {
                const byMe = r.userIds.includes(meId);
                return (
                  <button
                    key={r.emoji}
                    data-testid="reaction"
                    title={r.userIds.map((id) => (id === meId ? "You" : firstName(members.get(id)))).join(", ")}
                    className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs ${byMe ? "border-primary bg-primary/15" : "border-base-300 bg-base-100"}`}
                    onClick={() => void toggleReaction(message, r.emoji).catch((err) => toast.error(errorMessage(err)))}
                  >
                    <span>{r.emoji}</span>
                    <span className="font-medium">{r.userIds.length}</span>
                  </button>
                );
              })}
            </div>
          )}
          {pending?.status === "failed" && (
            <div className="mt-1 flex items-center gap-2 text-xs text-error" role="alert">
              <AlertCircle className="size-3.5" />
              <span>{pending.error ?? "Not sent"}</span>
              <button className="link" onClick={() => retry(pending.conversationId, pending.id)}>
                Retry
              </button>
              <button className="link" onClick={() => discard(pending.conversationId, pending.id)}>
                Delete
              </button>
            </div>
          )}
        </div>
        {message && !deleted && <Actions message={message} mine={mine} canDelete={canModerate} onMove={onMove} />}
      </div>
    </div>
  );
};
export default memo(MessageRow);
