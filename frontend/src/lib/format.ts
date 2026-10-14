import type { Conversation, LastMessage, Member, PublicUser } from "../types";

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Compact stamp for the chat list: a time today, otherwise a day or date. */
export function formatListTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return formatTime(iso);
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days < 6) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

export function formatDay(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return "Today";
  if (sameDay(d, new Date(now.getTime() - 86_400_000))) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

export const isSameDay = (a: string, b: string) => sameDay(new Date(a), new Date(b));

export function otherMember(c: Conversation, meId: string): Member | undefined {
  return c.members.find((m) => m.id !== meId);
}

export function conversationTitle(c: Conversation, meId: string): string {
  if (c.type === "group") return c.name ?? "Group";
  return otherMember(c, meId)?.fullName ?? "Deleted user";
}

export function conversationAvatar(c: Conversation, meId: string): string | null {
  return c.type === "group" ? c.avatarUrl : (otherMember(c, meId)?.avatarUrl ?? null);
}

export const firstName = (u: PublicUser | undefined) => u?.fullName.split(" ")[0] ?? "Someone";

export function previewText(m: Pick<LastMessage, "text" | "hasImage" | "deleted">): string {
  if (m.deleted) return "Message deleted";
  if (m.text) return m.text;
  return m.hasImage ? "Photo" : "";
}

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
