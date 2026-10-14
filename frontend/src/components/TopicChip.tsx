import { topicColor } from "../lib/topics";
import type { Topic } from "../types";

interface Props {
  topic: Topic | undefined;
  /** Still being worked out by the server (a moment after sending). */
  pending?: boolean;
  onClick?: () => void;
  className?: string;
}

/** The small label on a message saying which topic lane it is in. */
const TopicChip = ({ topic, pending, onClick, className = "" }: Props) => {
  if (!topic) {
    return pending ? <span data-testid="topic-chip-pending" className={`inline-block h-2 w-8 animate-pulse rounded-full bg-current opacity-30 ${className}`} /> : null;
  }
  return (
    <button
      type="button"
      data-testid="topic-chip"
      data-topic-id={topic.id}
      title={`Topic: ${topic.title}`}
      onClick={onClick}
      className={`flex min-w-0 max-w-40 items-center gap-1 rounded-full text-[10px] font-medium leading-none hover:underline ${className}`}
    >
      <span className="size-2 shrink-0 rounded-full ring-1 ring-white/60" style={{ background: topicColor(topic.id) }} />
      <span className="truncate">{topic.title}</span>
    </button>
  );
};
export default TopicChip;
