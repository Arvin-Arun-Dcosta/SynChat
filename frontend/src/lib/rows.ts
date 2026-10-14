import type { Message, PendingMessage } from "../types";

/** One row of the message list: a stored message, or one still being sent. */
export type RowItem = { kind: "message"; message: Message } | { kind: "pending"; pending: PendingMessage };

export const itemId = (item: RowItem) => (item.kind === "message" ? item.message.id : item.pending.id);
export const itemTime = (item: RowItem) => (item.kind === "message" ? item.message.createdAt : item.pending.createdAt);
export const itemSender = (item: RowItem, meId: string) => (item.kind === "message" ? item.message.senderId : meId);
