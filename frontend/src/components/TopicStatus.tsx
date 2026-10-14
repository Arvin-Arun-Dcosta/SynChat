import { CheckCircle2, CircleDashed } from "lucide-react";
import { useState } from "react";
import toast from "react-hot-toast";
import { errorMessage } from "../lib/api";
import { useChatStore } from "../store/useChatStore";
import type { Topic } from "../types";

/** A topic's decided/open badge. Read-only unless `editable`, where any member may override it. */
const TopicStatus = ({ topic, editable = false }: { topic: Topic; editable?: boolean }) => {
  const setTopicStatus = useChatStore((s) => s.setTopicStatus);
  const [open, setOpen] = useState(false);
  if (!topic.status && !editable) return null;

  const decided = topic.status === "decided";
  const badge = (
    <span
      data-testid="topic-status"
      data-status={topic.status ?? "none"}
      className={`badge badge-sm gap-1 ${decided ? "badge-success" : "badge-ghost"}`}
      title={topic.statusSource === "user" ? "Set by a member" : topic.status ? "Worked out by AI. Any member can change it." : "No status yet"}
    >
      {decided ? <CheckCircle2 className="size-3" /> : <CircleDashed className="size-3" />}
      {decided ? "Decided" : topic.status === "open" ? "Open" : "No status"}
    </span>
  );
  if (!editable) return badge;

  const apply = (status: "open" | "decided" | null, outcome?: string) => {
    setOpen(false);
    void setTopicStatus(topic.id, status, outcome).catch((err) => toast.error(errorMessage(err)));
  };
  const decide = () => {
    const outcome = window.prompt("What was decided? (shown at the top of the topic)", topic.outcome ?? "");
    if (outcome !== null) apply("decided", outcome.trim());
  };

  return (
    <span className="relative">
      <button aria-label="Change topic status" aria-expanded={open} onClick={() => setOpen(!open)}>
        {badge}
      </button>
      {open && (
        <>
          <button className="fixed inset-0 z-10 cursor-default" aria-label="Close menu" onClick={() => setOpen(false)} />
          <ul className="menu menu-sm absolute right-0 top-full z-20 mt-1 w-52 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg">
            <li>
              <button onClick={decide}>Mark as decided…</button>
            </li>
            <li>
              <button onClick={() => apply("open")}>Mark as still open</button>
            </li>
            {topic.statusSource === "user" && (
              <li>
                <button onClick={() => apply(null)}>Let AI decide again</button>
              </li>
            )}
          </ul>
        </>
      )}
    </span>
  );
};
export default TopicStatus;
