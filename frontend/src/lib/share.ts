import toast from "react-hot-toast";

export const groupInviteUrl = (token: string) => `${window.location.origin}/join/${token}`;
export const personalInviteUrl = (code: string) => `${window.location.origin}/u/${code}`;

/** Where to go after signing in, when an invite link was opened while signed out. */
export const AFTER_LOGIN_KEY = "after-login";

export async function copyText(text: string, done = "Copied"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    window.prompt("Copy this link", text);
  }
}
