import { Camera, Copy, Link2, LogOut, Pencil, ShieldCheck, ShieldOff, Trash2, UserMinus, UserPlus, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import toast from "react-hot-toast";
import { api, errorMessage } from "../lib/api";
import { IMAGE_ACCEPT } from "../lib/image";
import { copyText, groupInviteUrl as inviteUrl } from "../lib/share";
import { useAuthStore } from "../store/useAuthStore";
import { useChatStore } from "../store/useChatStore";
import { useConfigStore } from "../store/useConfigStore";
import type { Conversation, Invite, Member } from "../types";
import Avatar from "./Avatar";

const GroupInfoPanel = ({ conversation: c, onClose }: { conversation: Conversation; onClose: () => void }) => {
  const meId = useAuthStore((s) => s.user!.id);
  const upsertConversation = useChatStore((s) => s.upsertConversation);
  const removeConversation = useChatStore((s) => s.removeConversation);
  const online = useChatStore((s) => s.online);
  const canUpload = useConfigStore((s) => s.features.imageUpload);
  const aiConfigured = useConfigStore((s) => s.features.llm);
  const aiProvider = useConfigStore((s) => s.aiProvider);
  const isAdmin = c.myRole === "admin";
  const base = `/conversations/${c.id}`;
  const [name, setName] = useState<string | null>(null); // non-null while renaming
  const [username, setUsername] = useState("");
  const [invites, setInvites] = useState<Invite[]>([]);
  const [busy, setBusy] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    api
      .get<{ invites: Invite[] }>(`${base}/invites`)
      .then(({ data }) => !cancelled && setInvites(data.invites))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [base, isAdmin]);

  /** Run a change; the server answers with the updated conversation where there is one. */
  const act = async (request: () => Promise<{ data: { conversation?: Conversation } }>, done?: string) => {
    setBusy(true);
    try {
      const { data } = await request();
      if (data.conversation) upsertConversation(data.conversation);
      if (done) toast.success(done);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    const next = (name ?? "").trim();
    if (next && next !== c.name) await act(() => api.patch(base, { name: next }));
    setName(null);
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const u = username.trim().replace(/^@/, "").toLowerCase();
    if (u && (await act(() => api.post(`${base}/members`, { username: u })))) setUsername("");
  };

  const uploadAvatar = async (file: File | undefined) => {
    if (!file) return;
    const form = new FormData();
    form.append("image", file);
    await act(() => api.post(`${base}/avatar`, form));
  };

  const leave = async () => {
    if (!window.confirm(`Leave "${c.name}"?`)) return;
    if (await act(() => api.delete(`${base}/members/${meId}`))) {
      removeConversation(c.id);
      onClose();
    }
  };

  const remove = (m: Member) => {
    if (window.confirm(`Remove ${m.fullName} from the group?`)) void act(() => api.delete(`${base}/members/${m.id}`));
  };

  const createInvite = async () => {
    try {
      const { data } = await api.post<{ invite: Invite }>(`${base}/invites`);
      setInvites((list) => [data.invite, ...list]);
      await copyText(inviteUrl(data.invite.token), "Invite link copied");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const revokeInvite = async (invite: Invite) => {
    try {
      await api.delete(`${base}/invites/${invite.id}`);
      setInvites((list) => list.filter((i) => i.id !== invite.id));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-base-300 bg-base-100 shadow-xl sm:w-96" aria-label="Group info">
      <div className="flex items-center justify-between border-b border-base-300 px-4 py-3">
        <h3 className="font-semibold">Group info</h3>
        <button className="btn btn-ghost btn-sm btn-circle" aria-label="Close group info" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <Avatar name={c.name ?? "Group"} src={c.avatarUrl} seed={c.id} size={96} />
            {isAdmin && canUpload && (
              <>
                <input ref={filePicker} type="file" accept={IMAGE_ACCEPT} className="hidden" aria-label="Group photo" onChange={(e) => void uploadAvatar(e.target.files?.[0])} />
                <button className="btn btn-circle btn-sm absolute bottom-0 right-0" aria-label="Change group photo" disabled={busy} onClick={() => filePicker.current?.click()}>
                  <Camera className="size-4" />
                </button>
              </>
            )}
          </div>
          {name === null ? (
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold">{c.name}</span>
              {isAdmin && (
                <button className="btn btn-ghost btn-xs btn-circle" aria-label="Rename group" onClick={() => setName(c.name ?? "")}>
                  <Pencil className="size-3.5" />
                </button>
              )}
            </div>
          ) : (
            <form onSubmit={rename} className="flex w-full gap-2">
              <input autoFocus className="input input-sm flex-1" aria-label="Group name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn btn-primary btn-sm" disabled={busy}>
                Save
              </button>
            </form>
          )}
        </div>

        <section className="space-y-2">
          <h4 className="text-sm font-semibold text-base-content/70">
            {c.members.length} {c.members.length === 1 ? "member" : "members"}
          </h4>
          {isAdmin && (
            <form onSubmit={add} className="flex gap-2">
              <label className="input input-sm flex-1">
                <UserPlus className="size-4 opacity-50" />
                <input placeholder="Add by username" aria-label="Add member by username" value={username} onChange={(e) => setUsername(e.target.value)} />
              </label>
              <button className="btn btn-sm" disabled={busy || !username.trim()}>
                Add
              </button>
            </form>
          )}
          <ul>
            {c.members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 py-1.5" data-testid="member-row">
                <Avatar name={m.fullName} src={m.avatarUrl} seed={m.id} size={36} online={Boolean(online[m.id])} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {m.fullName}
                    {m.id === meId && <span className="text-base-content/50"> (you)</span>}
                  </div>
                  <div className="truncate text-xs text-base-content/60">@{m.username}</div>
                </div>
                {m.role === "admin" && <span className="badge badge-ghost badge-sm">Admin</span>}
                {isAdmin && m.id !== meId && (
                  <>
                    <button
                      className="btn btn-ghost btn-xs btn-circle"
                      disabled={busy}
                      aria-label={m.role === "admin" ? `Remove ${m.fullName} as admin` : `Make ${m.fullName} an admin`}
                      title={m.role === "admin" ? "Remove as admin" : "Make admin"}
                      onClick={() => void act(() => api.patch(`${base}/members/${m.id}`, { role: m.role === "admin" ? "member" : "admin" }))}
                    >
                      {m.role === "admin" ? <ShieldOff className="size-4" /> : <ShieldCheck className="size-4" />}
                    </button>
                    <button className="btn btn-ghost btn-xs btn-circle text-error" disabled={busy} aria-label={`Remove ${m.fullName}`} title="Remove from group" onClick={() => remove(m)}>
                      <UserMinus className="size-4" />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>

        {aiConfigured && (
          <section className="space-y-2" data-testid="ai-section">
            <h4 className="text-sm font-semibold text-base-content/70">AI features</h4>
            <label className={`flex items-start gap-3 rounded-lg border border-base-300 p-3 ${isAdmin ? "cursor-pointer" : ""}`}>
              <div className="min-w-0 flex-1 text-sm">
                <div className="font-medium">Sharper topic sorting, catch-up, decided-or-open and the questions inbox</div>
                <p className="mt-1 text-base-content/70">
                  Turning this on sends this group&apos;s messages to an outside AI provider{aiProvider ? ` (${aiProvider})` : ""} to sort them into topics and summarise them. It is off unless a group admin turns it on, and
                  everyone in the group is told when it changes.
                </p>
                {!isAdmin && <p className="mt-1 font-medium">{c.aiEnabled ? "A group admin has turned this on." : "This is off. Only a group admin can turn it on."}</p>}
              </div>
              {isAdmin && (
                <input
                  type="checkbox"
                  role="switch"
                  className="toggle toggle-primary mt-1"
                  aria-label="AI features for this group"
                  checked={c.aiEnabled}
                  disabled={busy}
                  onChange={(e) => void act(() => api.patch(`${base}/ai`, { enabled: e.target.checked }))}
                />
              )}
            </label>
          </section>
        )}

        {isAdmin && (
          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-base-content/70">Invite links</h4>
            <p className="text-xs text-base-content/60">Anyone with a link can join for 7 days. Revoke a link to stop it working.</p>
            <button className="btn btn-sm w-full" onClick={() => void createInvite()}>
              <Link2 className="size-4" /> Create invite link
            </button>
            <ul className="space-y-1">
              {invites.map((i) => (
                <li key={i.id} className="flex items-center gap-2 rounded-lg bg-base-200 px-2 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate font-mono">{inviteUrl(i.token)}</span>
                  <span className="shrink-0 text-base-content/60">{i.uses} joined</span>
                  <button className="btn btn-ghost btn-xs btn-circle" aria-label="Copy invite link" onClick={() => void copyText(inviteUrl(i.token), "Invite link copied")}>
                    <Copy className="size-3.5" />
                  </button>
                  <button className="btn btn-ghost btn-xs btn-circle text-error" aria-label="Revoke invite link" onClick={() => void revokeInvite(i)}>
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <button className="btn btn-outline btn-error btn-sm w-full" disabled={busy} onClick={() => void leave()}>
          <LogOut className="size-4" /> Leave group
        </button>
      </div>
    </aside>
  );
};
export default GroupInfoPanel;
