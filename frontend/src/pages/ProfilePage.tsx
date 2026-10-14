import { AtSign, Camera, Copy, Mail, RefreshCw, User } from "lucide-react";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import toast from "react-hot-toast";
import Avatar from "../components/Avatar";
import { api, errorMessage } from "../lib/api";
import { IMAGE_ACCEPT } from "../lib/image";
import { copyText, personalInviteUrl } from "../lib/share";
import { useAuthStore } from "../store/useAuthStore";
import { useConfigStore } from "../store/useConfigStore";
import type { Me } from "../types";

const Field = ({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) => (
  <div className="space-y-1.5">
    <div className="flex items-center gap-2 text-sm text-base-content/70">
      {icon}
      {label}
    </div>
    {children}
  </div>
);
const boxed = "rounded-lg border border-base-300 bg-base-200 px-4 py-2.5";

const ProfilePage = () => {
  const user = useAuthStore((s) => s.user!);
  const setUser = useAuthStore((s) => s.setUser);
  const canUpload = useConfigStore((s) => s.features.imageUpload);
  const [fullName, setFullName] = useState(user.fullName);
  const [busy, setBusy] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);
  const link = personalInviteUrl(user.inviteCode);

  const call = async (request: () => Promise<{ data: { user: Me } }>, done: string) => {
    setBusy(true);
    try {
      setUser((await request()).data.user);
      toast.success(done);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const saveName = (e: FormEvent) => {
    e.preventDefault();
    if (fullName.trim() && fullName.trim() !== user.fullName) void call(() => api.patch("/auth/profile", { fullName: fullName.trim() }), "Name updated");
  };

  const uploadAvatar = (file: File | undefined) => {
    if (!file) return;
    const form = new FormData();
    form.append("image", file);
    void call(() => api.post("/auth/avatar", form), "Photo updated");
  };

  const rotate = () => {
    if (window.confirm("Replace your invite link? The current one will stop working.")) {
      void call(() => api.post("/auth/invite-code"), "New invite link created");
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl p-4 py-8">
        <div className="space-y-8 rounded-2xl border border-base-300 bg-base-100 p-8 shadow-xl">
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight">Profile</h1>
            <p className="mt-1 text-base-content/70">Your account</p>
          </div>

          <div className="flex justify-center">
            <div className="relative">
              <Avatar name={user.fullName} src={user.avatarUrl} seed={user.id} size={128} />
              {canUpload && (
                <>
                  <input ref={filePicker} type="file" accept={IMAGE_ACCEPT} className="hidden" aria-label="Profile photo" onChange={(e) => uploadAvatar(e.target.files?.[0])} />
                  <button className="btn btn-circle btn-sm absolute bottom-1 right-1" aria-label="Change profile photo" disabled={busy} onClick={() => filePicker.current?.click()}>
                    <Camera className="size-4" />
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="space-y-5">
            <Field icon={<User className="size-4" />} label="Full name">
              <form onSubmit={saveName} className="flex gap-2">
                <input className="input flex-1" aria-label="Full name" maxLength={80} value={fullName} onChange={(e) => setFullName(e.target.value)} />
                <button className="btn btn-primary" disabled={busy || !fullName.trim() || fullName.trim() === user.fullName}>
                  Save
                </button>
              </form>
            </Field>
            <Field icon={<AtSign className="size-4" />} label="Username">
              <p className={boxed}>@{user.username}</p>
            </Field>
            <Field icon={<Mail className="size-4" />} label="Email (only you can see this)">
              <p className={boxed}>{user.email}</p>
            </Field>
          </div>

          <div className="space-y-2 border-t border-base-300 pt-6">
            <h2 className="font-semibold">Your invite link</h2>
            <p className="text-sm text-base-content/70">
              Share this so someone can start a chat with you without knowing your username. Nobody can find you by browsing or searching.
            </p>
            <div className="flex gap-2">
              <input className="input flex-1 font-mono text-sm" readOnly aria-label="Your invite link" value={link} onFocus={(e) => e.target.select()} />
              <button className="btn" aria-label="Copy invite link" onClick={() => void copyText(link, "Invite link copied")}>
                <Copy className="size-4" />
              </button>
              <button className="btn" aria-label="Replace invite link" title="Replace with a new link" disabled={busy} onClick={rotate}>
                <RefreshCw className="size-4" />
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-base-300 pt-4 text-sm">
            <span>Member since</span>
            <span>{new Date(user.createdAt).toLocaleDateString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
export default ProfilePage;
