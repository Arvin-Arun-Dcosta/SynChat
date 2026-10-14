import { Fragment } from "react";
import type { Member } from "../types";

interface Props {
  text: string;
  /** Ids of the members this message mentions, as resolved by the server. */
  mentions: string[];
  members: Map<string, Member>;
  meId: string;
}

/**
 * Message text with @mentions of members emphasised. The text is rendered as plain
 * text nodes only: nothing in a message is ever interpreted as markup.
 */
const MessageText = ({ text, mentions, members, meId }: Props) => {
  if (mentions.length === 0 || !text.includes("@")) return <p className="msg-text">{text}</p>;
  const byUsername = new Map(mentions.map((id) => members.get(id)).filter((m): m is Member => Boolean(m)).map((m) => [m.username.toLowerCase(), m]));
  const parts = text.split(/(@[a-z0-9_.]+)/gi);
  return (
    <p className="msg-text">
      {parts.map((part, i) => {
        const member = part.startsWith("@") ? byUsername.get(part.slice(1).toLowerCase().replace(/\.+$/, "")) : undefined;
        return member ? (
          <span key={i} data-testid="mention" className={`font-semibold ${member.id === meId ? "rounded bg-warning/40 px-0.5" : ""}`} title={member.fullName}>
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        );
      })}
    </p>
  );
};
export default MessageText;
