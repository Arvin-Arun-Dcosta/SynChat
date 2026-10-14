// Shapes returned by the API. Mirrors backend/src/types.ts.

export interface PublicUser {
  id: string;
  username: string;
  fullName: string;
  avatarUrl: string | null;
}

/** The smart features a person can switch on or off for themselves. */
export interface SmartSettings {
  lanes: boolean;
  topicMute: boolean;
  search: boolean;
  catchUp: boolean;
  status: boolean;
  inbox: boolean;
}
export type SmartFeature = keyof SmartSettings;

export interface Me extends PublicUser {
  email: string;
  inviteCode: string;
  createdAt: string;
  smart: SmartSettings;
}

export type Role = "admin" | "member";

export interface Member extends PublicUser {
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

export interface Message {
  id: string;
  conversationId: string;
  seq: number;
  rev: number;
  senderId: string | null;
  kind: "user" | "system";
  text: string | null;
  image: MessageImage | null;
  replyTo: ReplyPreview | null;
  reactions: Reaction[];
  /** The topic lane this message is in. Null in DMs, and briefly for a new group message. */
  topicId: string | null;
  /** Ids of the members this message @mentions. */
  mentions: string[];
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}

export interface MessageImage {
  url: string;
  width: number | null;
  height: number | null;
}

export interface Reaction {
  emoji: string;
  userIds: string[];
}

export interface Topic {
  id: string;
  conversationId: string;
  title: string;
  titleSource: "auto" | "user" | "llm";
  createdAt: string;
  messageCount: number;
  firstSeq: number;
  lastSeq: number;
  lastMessageAt: string;
  lastMessage: { senderId: string | null; text: string | null; hasImage: boolean } | null;
  participants: string[];
  unreadCount: number;
  /** Whether I have muted this topic. */
  muted: boolean;
  /** From the AI topic digest. Null unless the group's admin has turned AI features on. */
  recap: string | null;
  status: "open" | "decided" | null;
  outcome: string | null;
  statusSource: "llm" | "user" | null;
  /** Messages have arrived since the digest was made. */
  digestStale: boolean;
}

/** A question someone put to me that I have not answered. */
export interface InboxItem {
  id: string;
  question: string;
  topic: { id: string; title: string };
  message: Message;
}

export interface SearchHit {
  message: Message;
  matched: "keyword" | "meaning" | "both";
  score: number;
}

export interface SearchGroup {
  conversationId: string;
  topic: { id: string; title: string } | null;
  score: number;
  hits: SearchHit[];
}

export interface SearchResult {
  query: string;
  semantic: boolean;
  groups: SearchGroup[];
}

/** One change to a conversation's lanes, as sent by the server. */
export interface LaneUpdate {
  conversationId: string;
  rev: number | null;
  topics: Topic[];
  removed: string[];
  assignments: { messageId: string; topicId: string }[];
}

export interface Invite {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
  uses: number;
}

export interface LastMessage {
  id: string;
  seq: number;
  senderId: string | null;
  kind: "user" | "system";
  text: string | null;
  hasImage: boolean;
  deleted: boolean;
  createdAt: string;
}

export interface Conversation {
  id: string;
  type: "dm" | "group";
  name: string | null;
  avatarUrl: string | null;
  lastSeq: number;
  rev: number;
  lastMessageAt: string;
  createdAt: string;
  myRole: Role;
  myLastReadSeq: number;
  unreadCount: number;
  /** A group admin has turned on the features that send this group's messages to an outside AI provider. */
  aiEnabled: boolean;
  /** Topics of this conversation I have muted. */
  mutedTopicIds: string[];
  lastMessage: LastMessage | null;
  members: Member[];
}

/** A message the user has sent that the server has not confirmed yet. */
export interface PendingMessage {
  id: string;
  conversationId: string;
  text: string;
  replyTo: ReplyPreview | null;
  /** Set when sent from inside a lane: the topic it is pinned to. */
  topicId?: string;
  /** An image picked on this device. Uploaded first, then attached by its upload id. */
  image?: { file: File; previewUrl: string; width: number; height: number; uploadId?: string };
  createdAt: string;
  status: "sending" | "failed";
  error?: string;
}
