import { Plus, X } from "lucide-react";
import { useState } from "react";
import { topicColor } from "../lib/topics";
import type { Topic } from "../types";

interface Props {
  title: string;
  hint: string;
  topics: Topic[];
  /** The topic to leave out (where the thing being moved already is). */
  excludeId?: string | null;
  /** Offer "a new topic" as a destination, with an optional name. */
  allowNew?: boolean;
  confirmLabel: string;
  onPick: (target: { topicId: string } | { title?: string }) => Promise<void>;
  onClose: () => void;
}

/** Choose a topic: used to move a message, and to merge one topic into another. */
const TopicPickerDialog = ({ title, hint, topics, excludeId, allowNew = false, confirmLabel, onPick, onClose }: Props) => {
  const choices = topics.filter((t) => t.id !== excludeId);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await onPick(selected === "new" ? { title: newTitle.trim() || undefined } : { topicId: selected });
      onClose();
    } catch {
      setBusy(false); // the caller reports the error
    }
  };

  return (
    <dialog className="modal modal-open" aria-label={title}>
      <div className="modal-box max-w-md">
        <button className="btn btn-ghost btn-sm btn-circle absolute right-3 top-3" aria-label="Close" onClick={onClose}>
          <X className="size-4" />
        </button>
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="mb-3 mt-1 text-sm text-base-content/70">{hint}</p>
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {choices.map((t) => (
            <li key={t.id}>
              <label className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 ${selected === t.id ? "border-primary bg-primary/10" : "border-base-300"}`}>
                <input type="radio" name="topic" className="radio radio-sm radio-primary" checked={selected === t.id} onChange={() => setSelected(t.id)} />
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: topicColor(t.id) }} />
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <span className="shrink-0 text-xs text-base-content/50">{t.messageCount}</span>
              </label>
            </li>
          ))}
          {allowNew && (
            <li>
              <label className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 ${selected === "new" ? "border-primary bg-primary/10" : "border-base-300"}`}>
                <input type="radio" name="topic" className="radio radio-sm radio-primary" checked={selected === "new"} onChange={() => setSelected("new")} />
                <Plus className="size-4 shrink-0" />
                <span className="flex-1">A new topic</span>
              </label>
              {selected === "new" && (
                <input
                  autoFocus
                  className="input input-sm mt-2 w-full"
                  placeholder="Name it (optional)"
                  aria-label="New topic name"
                  maxLength={80}
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
              )}
            </li>
          )}
          {choices.length === 0 && !allowNew && <li className="py-4 text-center text-sm text-base-content/60">There is no other topic yet.</li>}
        </ul>
        <div className="modal-action">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!selected || busy} onClick={() => void confirm()}>
            {confirmLabel}
          </button>
        </div>
      </div>
      <button className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </dialog>
  );
};
export default TopicPickerDialog;
