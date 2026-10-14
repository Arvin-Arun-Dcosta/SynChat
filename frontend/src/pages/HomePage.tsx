import { useEffect } from "react";
import ChatPane from "../components/ChatPane";
import NoChatSelected from "../components/NoChatSelected";
import Sidebar from "../components/Sidebar";
import { useChatStore } from "../store/useChatStore";

const HomePage = () => {
  const active = useChatStore((s) => (s.activeId ? s.conversations[s.activeId] : undefined));
  const activeId = useChatStore((s) => s.activeId);
  const markRead = useChatStore((s) => s.markRead);
  const setActive = useChatStore((s) => s.setActive);
  const listLoaded = useChatStore((s) => s.listLoaded);

  // A notification was clicked: open the chat it was about. Either the app was
  // launched at /?c=<id>, or the service worker messages an already open window.
  useEffect(() => {
    if (!listLoaded) return;
    const open = (id: unknown) => {
      if (typeof id === "string" && useChatStore.getState().conversations[id]) setActive(id);
    };
    const params = new URLSearchParams(window.location.search);
    if (params.has("c")) {
      open(params.get("c"));
      window.history.replaceState(null, "", window.location.pathname);
    }
    const onMessage = (e: MessageEvent) => e.data?.type === "open-conversation" && open(e.data.conversationId);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, [listLoaded, setActive]);

  // Coming back to the tab counts as reading the open chat.
  useEffect(() => {
    if (!activeId) return;
    const onFocus = () => markRead(activeId);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [activeId, markRead]);

  return (
    <div className="mx-auto flex h-full max-w-7xl overflow-hidden bg-base-100 shadow-sm">
      <Sidebar />
      {active ? <ChatPane conversation={active} /> : <NoChatSelected />}
    </div>
  );
};
export default HomePage;
