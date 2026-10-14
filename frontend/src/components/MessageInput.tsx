import { ImagePlus, Pencil, Reply, Send, X } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import toast from "react-hot-toast";
import { errorMessage } from "../lib/api";
import { firstName, previewText } from "../lib/format";
import { IMAGE_ACCEPT, prepareImage, type PickedImage } from "../lib/image";
import { emitTyping, resetTyping } from "../lib/socket";
import { useAuthStore } from "../store/useAuthStore";
import { useChatStore } from "../store/useChatStore";
import { useConfigStore } from "../store/useConfigStore";
import type { Conversation, Topic } from "../types";

const MAX_LENGTH = 4000;

/** `lane` is set when the composer sits inside a topic lane: what is sent is pinned to it. */
const MessageInput = ({ conversation, lane }: { conversation: Conversation; lane?: Topic }) => {
  const conversationId = conversation.id;
  const meId = useAuthStore((s) => s.user!.id);
  const send = useChatStore((s) => s.send);
  const editMessage = useChatStore((s) => s.editMessage);
  const replyingTo = useChatStore((s) => s.replyingTo[conversationId]);
  const editing = useChatStore((s) => s.editing[conversationId]);
  const setReplyingTo = useChatStore((s) => s.setReplyingTo);
  const setEditing = useChatStore((s) => s.setEditing);
  const canSendImages = useConfigStore((s) => s.features.imageUpload);
  const [text, setText] = useState("");
  const [image, setImage] = useState<PickedImage | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);

  // Grow with the text, up to a few lines.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  useEffect(() => {
    box.current?.focus();
  }, [conversationId, replyingTo, editing]);

  // Starting an edit loads the message into the box.
  const [loadedEdit, setLoadedEdit] = useState<string | undefined>(undefined);
  if (editing?.id !== loadedEdit) {
    setLoadedEdit(editing?.id);
    setText(editing?.text ?? "");
  }

  const pick = async (file: File | undefined | null) => {
    if (!file) return;
    try {
      setImage(await prepareImage(file));
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const clearImage = (revoke: boolean) => {
    if (image && revoke) URL.revokeObjectURL(image.previewUrl);
    setImage(null);
    if (filePicker.current) filePicker.current.value = "";
  };

  const submit = () => {
    const body = text.trim();
    if (editing) {
      if (!body) return;
      if (body !== editing.text) void editMessage(editing, body).catch((err) => toast.error(errorMessage(err)));
      setEditing(conversationId, undefined);
      return;
    }
    if (!body && !image) return;
    send(conversationId, body, { replyTo: replyingTo ?? null, image: image ?? undefined, topicId: lane?.id });
    resetTyping(conversationId);
    setText("");
    clearImage(false); // the pending message now owns the preview URL
    if (replyingTo) setReplyingTo(conversationId, undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.key === "Enter" || e.key === "Tab") && suggestions.length > 0 && !e.shiftKey) {
      e.preventDefault();
      completeMention(suggestions[0]!.username);
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      if (editing) setEditing(conversationId, undefined);
      else if (replyingTo) setReplyingTo(conversationId, undefined);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!canSendImages || editing) return;
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith("image/"));
    if (file) {
      e.preventDefault();
      void pick(file);
    }
  };

  // Typing "@" offers the conversation's members; picking one completes the username.
  const mentionPrefix = /(?:^|\s)@([a-z0-9_.]*)$/i.exec(text)?.[1]?.toLowerCase();
  const suggestions =
    mentionPrefix === undefined
      ? []
      : conversation.members.filter((m) => m.id !== meId && (m.username.startsWith(mentionPrefix) || m.fullName.toLowerCase().startsWith(mentionPrefix))).slice(0, 5);
  const completeMention = (username: string) => {
    setText(text.replace(/@[a-z0-9_.]*$/i, `@${username} `));
    box.current?.focus();
  };

  const context = editing ?? replyingTo;
  const author = context ? (context.senderId === meId ? "yourself" : firstName(conversation.members.find((m) => m.id === context.senderId))) : "";

  return (
    <div className="shrink-0 border-t border-base-300 bg-base-100">
      {context && (
        <div className="flex items-center gap-3 border-b border-base-300 px-4 py-2 text-sm" data-testid="composer-context">
          {editing ? <Pencil className="size-4 shrink-0 text-primary" /> : <Reply className="size-4 shrink-0 text-primary" />}
          <div className="min-w-0 flex-1">
            <div className="font-medium text-primary">{editing ? "Editing message" : `Replying to ${author}`}</div>
            <div className="truncate text-base-content/60">{previewText({ text: context.text, hasImage: context.image !== null, deleted: context.deleted })}</div>
          </div>
          <button
            className="btn btn-ghost btn-xs btn-circle"
            aria-label="Cancel"
            onClick={() => (editing ? setEditing(conversationId, undefined) : setReplyingTo(conversationId, undefined))}
          >
            <X className="size-4" />
          </button>
        </div>
      )}
      {image && (
        <div className="px-4 pt-3">
          <div className="relative inline-block">
            <img src={image.previewUrl} alt="Image to send" className="size-20 rounded-lg border border-base-300 object-cover" />
            <button className="btn btn-circle btn-xs absolute -right-2 -top-2" aria-label="Remove image" onClick={() => clearImage(true)}>
              <X className="size-3" />
            </button>
          </div>
        </div>
      )}
      {suggestions.length > 0 && (
        <ul className="mx-3 mt-2 rounded-box border border-base-300 bg-base-100 p-1 shadow" aria-label="Mention someone">
          {suggestions.map((m, i) => (
            <li key={m.id}>
              <button type="button" className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-base-200 ${i === 0 ? "bg-base-200" : ""}`} onClick={() => completeMention(m.username)}>
                <span className="font-medium">{m.fullName}</span>
                <span className="text-base-content/50">@{m.username}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex items-end gap-2 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {canSendImages && !editing && (
          <>
            <input ref={filePicker} type="file" accept={IMAGE_ACCEPT} className="hidden" aria-label="Attach image" onChange={(e) => void pick(e.target.files?.[0])} />
            <button type="button" className="btn btn-ghost btn-circle" aria-label="Attach an image" title="Attach an image" onClick={() => filePicker.current?.click()}>
              <ImagePlus className="size-5" />
            </button>
          </>
        )}
        <textarea
          ref={box}
          rows={1}
          className="textarea min-h-10 flex-1 resize-none leading-snug"
          placeholder={image ? "Add a caption" : lane ? `Message in “${lane.title}”` : "Type a message"}
          aria-label="Message"
          maxLength={MAX_LENGTH}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value.trim() && !editing) emitTyping(conversationId);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button type="submit" className="btn btn-primary btn-circle" aria-label={editing ? "Save" : "Send"} disabled={!text.trim() && !image}>
          <Send className="size-5" />
        </button>
      </form>
    </div>
  );
};
export default MessageInput;
