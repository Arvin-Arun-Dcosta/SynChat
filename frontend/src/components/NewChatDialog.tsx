import { Search, UserPlus, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import toast from "react-hot-toast";
import { api, errorMessage } from "../lib/api";
import { useAuthStore } from "../store/useAuthStore";
import { useChatStore } from "../store/useChatStore";
import type { Conversation, PublicUser } from "../types";
import Avatar from "./Avatar";

const clean = (username: string) => username.trim().replace(/^@/, "").toLowerCase();

async function lookup(username: string): Promise<PublicUser> {
  const { data } = await api.get<{ user: PublicUser }>("/users/lookup", { params: { username } });
  return data.user;
}

const NewChatDialog = ({ onClose }: { onClose: () => void }) => {
  const me = useAuthStore((s) => s.user!);
  const upsertConversation = useChatStore((s) => s.upsertConversation);
  const setActive = useChatStore((s) => s.setActive);
  const [tab, setTab] = useState<"dm" | "group">("dm");
  const [username, setUsername] = useState("");
  const [groupName, setGroupName] = useState("");
  const [picked, setPicked] = useState<PublicUser[]>([]);
  const [busy, setBusy] = useState(false);

  const open = (conversation: Conversation) => {
    upsertConversation(conversation);
    setActive(conversation.id);
    onClose();
  };

  const startDm = async (e: FormEvent) => {
    e.preventDefault();
    if (!clean(username)) return;
    setBusy(true);
    try {
      const { data } = await api.post<{ conversation: Conversation }>("/conversations/dm", { username: clean(username) });
      open(data.conversation);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const addMember = async (e: FormEvent) => {
    e.preventDefault();
    const name = clean(username);
    if (!name) return;
    if (name === me.username || picked.some((p) => p.username === name)) {
      setUsername("");
      return;
    }
    setBusy(true);
    try {
      const user = await lookup(name);
      setPicked((p) => [...p, user]);
      setUsername("");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const createGroup = async () => {
    setBusy(true);
    try {
      const { data } = await api.post<{ conversation: Conversation }>("/conversations/group", {
        name: groupName.trim(),
        usernames: picked.map((p) => p.username),
      });
      open(data.conversation);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog className="modal modal-open" aria-label="New chat">
      <div className="modal-box max-w-md">
        <button className="btn btn-ghost btn-sm btn-circle absolute right-3 top-3" aria-label="Close" onClick={onClose}>
          <X className="size-4" />
        </button>
        <h3 className="mb-4 text-lg font-semibold">New chat</h3>

        <div role="tablist" className="tabs tabs-box mb-4">
          <button role="tab" className={`tab flex-1 ${tab === "dm" ? "tab-active" : ""}`} onClick={() => setTab("dm")}>
            Direct message
          </button>
          <button role="tab" className={`tab flex-1 ${tab === "group" ? "tab-active" : ""}`} onClick={() => setTab("group")}>
            Group
          </button>
        </div>

        {tab === "dm" ? (
          <form onSubmit={startDm} className="space-y-3">
            <p className="text-sm text-base-content/70">Enter the exact username of the person you want to message.</p>
            <label className="input w-full">
              <Search className="size-4 opacity-50" />
              <input autoFocus placeholder="username" aria-label="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <button className="btn btn-primary w-full" disabled={busy || !clean(username)}>
              Start chat
            </button>
          </form>
        ) : (
          <div className="space-y-3">
            <input
              className="input w-full"
              placeholder="Group name"
              aria-label="Group name"
              maxLength={80}
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />
            <form onSubmit={addMember} className="flex gap-2">
              <label className="input flex-1">
                <UserPlus className="size-4 opacity-50" />
                <input placeholder="Add by username" aria-label="Add member by username" value={username} onChange={(e) => setUsername(e.target.value)} />
              </label>
              <button className="btn" disabled={busy || !clean(username)}>
                Add
              </button>
            </form>
            {picked.length > 0 && (
              <ul className="space-y-1">
                {picked.map((u) => (
                  <li key={u.id} className="flex items-center gap-2 rounded-lg bg-base-200 px-2 py-1.5">
                    <Avatar name={u.fullName} src={u.avatarUrl} seed={u.id} size={28} />
                    <span className="flex-1 truncate text-sm">
                      {u.fullName} <span className="text-base-content/50">@{u.username}</span>
                    </span>
                    <button className="btn btn-ghost btn-xs btn-circle" aria-label={`Remove ${u.fullName}`} onClick={() => setPicked((p) => p.filter((x) => x.id !== u.id))}>
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button className="btn btn-primary w-full" disabled={busy || !groupName.trim()} onClick={() => void createGroup()}>
              Create group{picked.length > 0 ? ` with ${picked.length + 1} people` : ""}
            </button>
          </div>
        )}
      </div>
      <button className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </dialog>
  );
};
export default NewChatDialog;
