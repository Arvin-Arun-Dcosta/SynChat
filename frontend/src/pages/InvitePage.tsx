import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useNavigate, useParams } from "react-router-dom";
import Avatar from "../components/Avatar";
import { api, errorMessage } from "../lib/api";
import { AFTER_LOGIN_KEY } from "../lib/share";
import { useChatStore } from "../store/useChatStore";
import type { Conversation, PublicUser } from "../types";

interface GroupPreview {
  id: string | null;
  name: string;
  avatarUrl: string | null;
  memberCount: number;
  alreadyMember: boolean;
}

type Target = { kind: "user"; user: PublicUser } | { kind: "group"; group: GroupPreview };

/** Landing page for both kinds of invite link: /u/<code> (a person) and /join/<token> (a group). */
const InvitePage = ({ kind }: { kind: "user" | "group" }) => {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const upsertConversation = useChatStore((s) => s.upsertConversation);
  const setActive = useChatStore((s) => s.setActive);
  const [target, setTarget] = useState<Target | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sessionStorage.removeItem(AFTER_LOGIN_KEY);
    let cancelled = false;
    const request =
      kind === "user"
        ? api.get<{ user: PublicUser }>(`/users/invite/${encodeURIComponent(code)}`).then((r): Target => ({ kind: "user", user: r.data.user }))
        : api.get<{ group: GroupPreview }>(`/invites/${encodeURIComponent(code)}`).then((r): Target => ({ kind: "group", group: r.data.group }));
    request.then((t) => !cancelled && setTarget(t)).catch((err) => !cancelled && setError(errorMessage(err, "That invite link is not valid")));
    return () => {
      cancelled = true;
    };
  }, [kind, code]);

  const accept = async () => {
    setBusy(true);
    try {
      const { data } =
        kind === "user"
          ? await api.post<{ conversation: Conversation }>("/conversations/dm", { inviteCode: code })
          : await api.post<{ conversation: Conversation }>(`/invites/${encodeURIComponent(code)}/accept`);
      upsertConversation(data.conversation);
      setActive(data.conversation.id);
      void navigate("/", { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-5 rounded-2xl border border-base-300 bg-base-100 p-8 text-center shadow-xl">
        {error && (
          <>
            <h1 className="text-xl font-semibold">Invite not valid</h1>
            <p className="text-base-content/70">{error}</p>
            <button className="btn w-full" onClick={() => void navigate("/", { replace: true })}>
              Back to chats
            </button>
          </>
        )}
        {!error && !target && <span className="loading loading-spinner" />}
        {target?.kind === "user" && (
          <>
            <div className="flex justify-center">
              <Avatar name={target.user.fullName} src={target.user.avatarUrl} seed={target.user.id} size={88} />
            </div>
            <div>
              <h1 className="text-xl font-semibold">{target.user.fullName}</h1>
              <p className="text-base-content/60">@{target.user.username}</p>
            </div>
            <button className="btn btn-primary w-full" disabled={busy} onClick={() => void accept()}>
              Message {target.user.fullName.split(" ")[0]}
            </button>
          </>
        )}
        {target?.kind === "group" && (
          <>
            <div className="flex justify-center">
              <Avatar name={target.group.name} src={target.group.avatarUrl} seed={target.group.name} size={88} />
            </div>
            <div>
              <h1 className="text-xl font-semibold">{target.group.name}</h1>
              <p className="text-base-content/60">
                {target.group.memberCount} {target.group.memberCount === 1 ? "member" : "members"}
              </p>
            </div>
            <button className="btn btn-primary w-full" disabled={busy} onClick={() => void accept()}>
              {target.group.alreadyMember ? "Open group" : "Join group"}
            </button>
          </>
        )}
      </div>
    </div>
  );
};
export default InvitePage;
