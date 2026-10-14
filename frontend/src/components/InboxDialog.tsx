import { Check, X } from "lucide-react";
import toast from "react-hot-toast";
import { errorMessage } from "../lib/api";
import { conversationTitle, firstName, formatListTime } from "../lib/format";
import { topicColor } from "../lib/topics";
import { useAuthStore } from "../store/useAuthStore";
import { useChatStore } from "../store/useChatStore";
import type { InboxItem } from "../types";

/** Questions waiting on me: found by the AI digest in groups that have AI features on. */
const InboxDialog = ({ onClose }: { onClose: () => void }) => {
  const meId = useAuthStore((s) => s.user!.id);
  const inbox = useChatStore((s) => s.inbox);
  const conversations = useChatStore((s) => s.conversations);
  const revealMessage = useChatStore((s) => s.revealMessage);
  const dismissQuestion = useChatStore((s) => s.dismissQuestion);

  const open = (item: InboxItem) => {
    onClose();
    void revealMessage(item.message);
  };

  return (
    <dialog className="modal modal-open" aria-label="Questions waiting on you">
      <div className="modal-box flex max-h-[80vh] max-w-lg flex-col p-0">
        <div className="flex items-center justify-between border-b border-base-300 px-4 py-3">
          <div>
            <h3 className="font-semibold">Questions waiting on you</h3>
            <p className="text-xs text-base-content/60">Found by AI in groups that have AI features on. It can miss things or get them wrong.</p>
          </div>
          <button className="btn btn-ghost btn-sm btn-circle" aria-label="Close" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="inbox">
          {inbox.length === 0 && <li className="p-6 text-center text-sm text-base-content/60">Nothing is waiting on you.</li>}
          {inbox.map((item) => {
            const conversation = conversations[item.message.conversationId];
            if (!conversation) return null;
            const asker = item.message.senderId === meId ? "You" : firstName(conversation.members.find((m) => m.id === item.message.senderId));
            return (
              <li key={item.id} className="flex items-start gap-1 rounded-lg hover:bg-base-200" data-testid="inbox-item">
                <button className="min-w-0 flex-1 px-3 py-2 text-left" onClick={() => open(item)}>
                  {/* Model-written text: shown as plain text, like everything else here. */}
                  <p className="font-medium">{item.question}</p>
                  <p className="line-clamp-2 text-sm text-base-content/70">
                    {asker}: {item.message.text}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-xs text-base-content/60">
                    <span className="truncate">{conversationTitle(conversation, meId)}</span>
                    <span className="size-2 shrink-0 rounded-full" style={{ background: topicColor(item.topic.id) }} />
                    <span className="truncate">{item.topic.title}</span>
                    <span className="shrink-0">· {formatListTime(item.message.createdAt)}</span>
                  </p>
                </button>
                <button
                  className="btn btn-ghost btn-sm btn-circle mt-2 mr-1"
                  aria-label={`Dismiss: ${item.question}`}
                  title="Dismiss"
                  onClick={() => void dismissQuestion(item.id).catch((err) => toast.error(errorMessage(err)))}
                >
                  <Check className="size-4" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <button className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </dialog>
  );
};
export default InboxDialog;
