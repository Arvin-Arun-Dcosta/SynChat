import { Search, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { conversationTitle, firstName, formatListTime } from "../lib/format";
import { topicColor } from "../lib/topics";
import { useAuthStore } from "../store/useAuthStore";
import { useChatStore } from "../store/useChatStore";
import type { Message, SearchResult } from "../types";

/** Search across all of my conversations, by words and by meaning, grouped by topic. */
const SearchDialog = ({ onClose }: { onClose: () => void }) => {
  const meId = useAuthStore((s) => s.user!.id);
  const conversations = useChatStore((s) => s.conversations);
  const revealMessage = useChatStore((s) => s.revealMessage);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let cancelled = false;
    // Wait for a pause in typing before asking the server.
    const timer = setTimeout(() => {
      setBusy(true);
      api
        .get<SearchResult>("/search", { params: { q } })
        .then(({ data }) => {
          if (cancelled) return;
          setResult(data);
          setError(null);
        })
        .catch((err) => !cancelled && setError(errorMessage(err)))
        .finally(() => !cancelled && setBusy(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const open = (m: Message) => {
    onClose();
    void revealMessage(m);
  };
  const shown = query.trim().length >= 2 ? result : null;

  return (
    <dialog className="modal modal-open items-start pt-[10vh]" aria-label="Search">
      <div className="modal-box flex max-h-[75vh] max-w-xl flex-col p-0">
        <div className="flex items-center gap-2 border-b border-base-300 p-3">
          <Search className="size-5 shrink-0 opacity-50" />
          <input
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-base outline-none"
            placeholder="Search your chats by words or meaning"
            aria-label="Search messages"
            maxLength={200}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
          />
          {busy && <span className="loading loading-spinner loading-sm" />}
          <button className="btn btn-ghost btn-sm btn-circle" aria-label="Close search" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="search-results">
          {error && <p className="p-4 text-center text-sm text-error">{error}</p>}
          {!error && !shown && <p className="p-6 text-center text-sm text-base-content/60">Try a few words, or describe what the message was about.</p>}
          {!error && shown && shown.groups.length === 0 && <p className="p-6 text-center text-sm text-base-content/60">Nothing found for “{shown.query}”.</p>}
          {!error && shown && !shown.semantic && shown.groups.length > 0 && (
            <p className="px-3 pb-2 text-xs text-base-content/60">Meaning search is unavailable right now; showing word matches only.</p>
          )}
          {!error &&
            shown?.groups.map((g) => {
              const conversation = conversations[g.conversationId];
              if (!conversation) return null;
              return (
                <section key={`${g.conversationId}:${g.topic?.id ?? ""}`} className="mb-3" data-testid="search-group">
                  <h4 className="flex items-center gap-2 px-3 py-1 text-xs font-semibold text-base-content/70">
                    <span className="truncate">{conversationTitle(conversation, meId)}</span>
                    {g.topic && (
                      <>
                        <span className="size-2 shrink-0 rounded-full" style={{ background: topicColor(g.topic.id) }} />
                        <span className="truncate" data-testid="search-topic">
                          {g.topic.title}
                        </span>
                      </>
                    )}
                  </h4>
                  <ul>
                    {g.hits.map((h) => (
                      <li key={h.message.id}>
                        <button className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-base-200" data-testid="search-hit" onClick={() => open(h.message)}>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2 text-xs text-base-content/60">
                              <span className="font-medium text-base-content">
                                {h.message.senderId === meId ? "You" : firstName(conversation.members.find((m) => m.id === h.message.senderId))}
                              </span>
                              <span>{formatListTime(h.message.createdAt)}</span>
                            </div>
                            <p className="line-clamp-2 text-sm">{h.message.text}</p>
                          </div>
                          {h.matched === "meaning" && (
                            <span className="badge badge-ghost badge-sm shrink-0 gap-1" title="Found by meaning, not by matching words">
                              <Sparkles className="size-3" /> meaning
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
        </div>
      </div>
      <button className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </dialog>
  );
};
export default SearchDialog;
