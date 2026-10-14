// Shapes sent to clients. frontend/src/types.ts mirrors these.
import type { SmartSettings } from "./users/smart.js";

export interface PublicUser {
  id: string;
  username: string;
  fullName: string;
  avatarUrl: string | null;
}

export interface Me extends PublicUser {
  email: string;
  inviteCode: string;
  createdAt: string | Date;
  /** Which smart features this person has left switched on. */
  smart: SmartSettings;
}

export type Role = "admin" | "member";

export interface MemberDto extends PublicUser {
  role: Role;
  lastReadSeq: number;
}

export interface ReplyPreview {
  id: string;
  senderId: string | null;
  text: string | null;
  hasImage: boolean;
  deleted: boolean;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  seq: number;
  rev: number;
  senderId: string | null;
  kind: "user" | "system";
  text: string | null;
  image: ImageDto | null;
  replyTo: ReplyPreview | null;
  reactions: ReactionDto[];
  /** The topic lane this message is in. Null in DMs, and briefly for a new group message. */
  topicId: string | null;
  /** Ids of the members this message @mentions. */
  mentions: string[];
  createdAt: string | Date;
  editedAt: string | Date | null;
  deleted: boolean;
}

export interface ImageDto {
  url: string;
  width: number | null;
  height: number | null;
}

export interface ReactionDto {
  emoji: string;
  userIds: string[];
}

export interface TopicDto {
  id: string;
  conversationId: string;
  title: string;
  titleSource: "auto" | "user" | "llm";
  createdAt: string | Date;
  messageCount: number;
  firstSeq: number;
  lastSeq: number;
  lastMessageAt: string | Date;
  lastMessage: { senderId: string | null; text: string | null; hasImage: boolean } | null;
  /** Up to six people who have spoken in the topic, most recent first. */
  participants: string[];
  /** For the member who asked. Always 0 in realtime events, which go to everyone. */
  unreadCount: number;
  /** Whether the member who asked has muted this topic. Always false in realtime events. */
  muted: boolean;
  /** From the topic digest; null unless the group's admin has turned AI features on. */
  recap: string | null;
  status: "open" | "decided" | null;
  outcome: string | null;
  /** 'user' when a member set the status by hand. */
  statusSource: "llm" | "user" | null;
  /** True when messages have arrived since the digest was made. */
  digestStale: boolean;
}

/** A question put to me that I have not answered. */
export interface InboxItemDto {
  id: string;
  question: string;
  topic: { id: string; title: string };
  message: MessageDto;
}

export interface InviteDto {
  id: string;
  token: string;
  createdAt: string | Date;
  expiresAt: string | Date;
  uses: number;
}

export interface LastMessageDto {
  id: string;
  seq: number;
  senderId: string | null;
  kind: "user" | "system";
  text: string | null;
  hasImage: boolean;
  deleted: boolean;
  createdAt: string | Date;
}

export interface ConversationDto {
  id: string;
  type: "dm" | "group";
  name: string | null;
  avatarUrl: string | null;
  lastSeq: number;
  rev: number;
  lastMessageAt: string | Date;
  createdAt: string | Date;
  myRole: Role;
  myLastReadSeq: number;
  unreadCount: number;
  /** A group admin has turned on the features that send this group's messages to an outside AI provider. */
  aiEnabled: boolean;
  /** Topics of this conversation the viewer has muted (empty if they switched topic mute off). */
  mutedTopicIds: string[];
  lastMessage: LastMessageDto | null;
  members: MemberDto[];
}
